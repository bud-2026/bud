import argparse
import asyncio
import inspect
import io
import threading
import torch
import uvicorn
import scipy.io.wavfile
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pocket_tts import TTSModel
from starlette.concurrency import iterate_in_threadpool

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=0)
args = parser.parse_args()

model = None
VOICE_STATES = {}
DEFAULT_VOICE = "jane"
STREAM_SUPPORTS_STOP = False

@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, VOICE_STATES, STREAM_SUPPORTS_STOP
    print("Loading Pocket-TTS model...", flush=True)
    model = TTSModel.load_model("english_18m_2026-10")

    try:
        parameters = inspect.signature(model.generate_audio_stream).parameters
        STREAM_SUPPORTS_STOP = "stop" in parameters
    except (TypeError, ValueError):
        STREAM_SUPPORTS_STOP = False

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
    return {"ok": model is not None}


class TTSRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE


def sanitize_text(text: str) -> str:
    """Ensure text ends with valid punctuation so the TTS model hits its natural EOS token."""
    cleaned = text.strip()
    if cleaned and cleaned[-1] not in ".!?":
        cleaned += "."
    return cleaned


# -------------------------------------------------------------------
# 1. Non-Streaming Endpoint (Returns complete .wav file)
# -------------------------------------------------------------------
@app.post("/tts")
def tts_endpoint(req: TTSRequest):
    try:
        voice_state = VOICE_STATES.get(req.voice) or model.get_state_for_audio_prompt(req.voice)
        final_text = sanitize_text(req.text)

        audio_tensor = model.generate_audio(voice_state, final_text)

        buffer = io.BytesIO()
        scipy.io.wavfile.write(buffer, rate=model.sample_rate, data=audio_tensor.numpy())
        buffer.seek(0)

        return Response(content=buffer.read(), media_type="audio/wav")
    except Exception as e:
        return Response(content=f"TTS Error: {str(e)}", status_code=500)


# -------------------------------------------------------------------
# 2. Streaming Endpoint (Streams raw little-endian float32 PCM)
# -------------------------------------------------------------------
def stream_pcm_audio(voice_state, text: str, stop: threading.Event):
    final_text = sanitize_text(text)
    kwargs = {"stop": stop} if STREAM_SUPPORTS_STOP else {}

    for chunk_tensor in model.generate_audio_stream(voice_state, final_text, **kwargs):
        samples = (
            chunk_tensor.detach()
            .to(device="cpu", dtype=torch.float32)
            .contiguous()
            .reshape(-1)
            .numpy()
        )
        yield samples.tobytes()


@app.post("/tts-stream")
async def tts_stream_endpoint(req: TTSRequest, request: Request):
    try:
        voice_state = VOICE_STATES.get(req.voice) or model.get_state_for_audio_prompt(req.voice)
    except Exception as e:
        return Response(content=f"TTS Error: {str(e)}", status_code=500)

    stop = threading.Event()

    async def stop_on_disconnect() -> None:
        while not stop.is_set():
            try:
                if await request.is_disconnected():
                    stop.set()
                    return
            except Exception:
                return
            await asyncio.sleep(0.25)

    async def audio_chunks():
        monitor = asyncio.create_task(stop_on_disconnect())
        try:
            async for chunk in iterate_in_threadpool(
                stream_pcm_audio(voice_state, req.text, stop)
            ):
                yield chunk
        finally:
            stop.set()
            monitor.cancel()

    return StreamingResponse(
        audio_chunks(),
        media_type="audio/L32",
        headers={
            "X-Sample-Rate": str(model.sample_rate),
            "X-Channels": "1",
            "X-Sample-Format": "f32le",
            "Cache-Control": "no-store",
        },
    )


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")