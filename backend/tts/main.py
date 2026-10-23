import argparse
import io
import uvicorn
import scipy.io.wavfile
from contextlib import asynccontextmanager
from fastapi import FastAPI, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pocket_tts import TTSModel

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=0)
args = parser.parse_args()

model = None
VOICE_STATES = {}
DEFAULT_VOICE = "jane"

@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, VOICE_STATES
    print("Loading Pocket-TTS model...", flush=True)
    model = TTSModel.load_model("english_18m_2026-10")

    print("Pre-caching voice states...", flush=True)
    for voice_name in [DEFAULT_VOICE, "alba"]:
        try:
            VOICE_STATES[voice_name] = model.get_state_for_audio_prompt(voice_name)
        except Exception as e:
            print(f"Could not pre-cache voice {voice_name}: {e}", flush=True)

    print("Server ready!", flush=True)
    yield
    VOICE_STATES.clear()

app = FastAPI(
    title="Pocket-TTS API",
    lifespan=lifespan
)


@app.get("/health")
def health():
    # Uvicorn only serves requests once the lifespan startup (model load)
    # completes, so a responding /health implies the model is ready.
    return {"ok": model is not None}


class TTSRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE


# -------------------------------------------------------------------
# 1. Non-Streaming Endpoint (Returns complete .wav file)
# -------------------------------------------------------------------
@app.post("/tts")
def tts_endpoint(req: TTSRequest):
    try:
        # Use cached state if available, otherwise fallback to on-demand lookup
        voice_state = VOICE_STATES.get(req.voice) or model.get_state_for_audio_prompt(req.voice)

        # Generate complete audio tensor
        audio_tensor = model.generate_audio(voice_state, req.text)

        # Write to WAV byte buffer
        buffer = io.BytesIO()
        scipy.io.wavfile.write(buffer, rate=model.sample_rate, data=audio_tensor.numpy())
        buffer.seek(0)

        return Response(content=buffer.read(), media_type="audio/wav")
    except Exception as e:
        return Response(content=f"TTS Error: {str(e)}", status_code=500)


# -------------------------------------------------------------------
# 2. Streaming Endpoint (Streams raw PCM audio chunks frame-by-frame)
# -------------------------------------------------------------------
def stream_pcm_audio(voice_state, text: str):
    # generate_audio_stream yields audio tensor chunks frame-by-frame
    for chunk_tensor in model.generate_audio_stream(voice_state, text):
        yield chunk_tensor.numpy().tobytes()

@app.post("/tts-stream")
def tts_stream_endpoint(req: TTSRequest):
    try:
        voice_state = VOICE_STATES.get(req.voice) or model.get_state_for_audio_prompt(req.voice)

        return StreamingResponse(
            stream_pcm_audio(voice_state, req.text),
            media_type="audio/pcm",
            headers={"X-Sample-Rate": str(model.sample_rate)}
        )
    except Exception as e:
        return Response(content=f"TTS Error: {str(e)}", status_code=500)


if __name__ == "__main__":
    # Pass the app object directly: the import-string form ("main:app") relies
    # on `import main`, which fails in the PyInstaller bundle because the entry
    # script is frozen as __main__ rather than an importable `main` module.
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")