import json
import os
import threading
import time
from pathlib import Path
from typing import Any


def emit(event: str, **data: Any) -> None:
    print(json.dumps({"event": event, **data}), flush=True)


def value_from_line(line: Any) -> str:
    if isinstance(line, str):
        return line.strip()
    if isinstance(line, dict):
        return str(line.get("text", "")).strip()
    return str(getattr(line, "text", "")).strip()


def resolve_wake_word_model() -> tuple[Path, str]:
    configured_path = os.environ.get("WAKEWORD_MODEL_PATH", "backend/stt/models/hey_bud.onnx")
    model_file = Path(configured_path)
    if not model_file.is_absolute():
        project_root = Path(__file__).resolve().parents[2]
        project_relative = project_root / model_file
        model_file = project_relative if project_relative.exists() else Path.cwd() / model_file

    if model_file.exists():
        return model_file, "hey bud"

    fallback_name = os.environ.get("WAKEWORD_FALLBACK", "hey_mycroft")
    import openwakeword
    from openwakeword.utils import download_models

    fallback = openwakeword.MODELS.get(fallback_name)
    if fallback is None:
        supported = ", ".join(sorted(openwakeword.MODELS))
        raise ValueError(f"Unknown WAKEWORD_FALLBACK '{fallback_name}'. Supported values: {supported}")

    fallback_file = Path(fallback["model_path"]).with_suffix(".onnx")
    if not fallback_file.exists():
        emit(
            "status",
            message=f"Downloading local fallback wake word model '{fallback_name}'..."
        )
        download_models([fallback_name])
    if not fallback_file.exists():
        raise FileNotFoundError(f"Fallback wake-word model was not installed: {fallback_file}")

    return fallback_file, fallback_name.replace("_", " ")


def run() -> None:
    try:
        import numpy as np
        from openwakeword.model import Model as WakeWordModel
        from pvrecorder import PvRecorder
        from moonshine_voice import MicTranscriber, ModelArch
    except ImportError as error:
        emit("error", message=f"STT dependency is missing: {error}")
        return

    silence_timeout = float(os.environ.get("STT_SILENCE_TIMEOUT", "2.5"))
    minimum_transcription_time = float(
        os.environ.get("STT_MIN_TRANSCRIPTION_SECONDS", "1.5")
    )
    wake_threshold = float(os.environ.get("WAKEWORD_THRESHOLD", "0.5"))
    language = os.environ.get("MOONSHINE_LANGUAGE", "en")
    latest_text = ""
    last_speech_at = 0.0
    stop_transcription = threading.Event()

    try:
        model_file, wake_word_name = resolve_wake_word_model()
        wake_word = WakeWordModel(
            wakeword_models=[str(model_file)],
            inference_framework="onnx",
        )
        recorder = PvRecorder(
            device_index=int(os.environ.get("STT_AUDIO_DEVICE", "-1")),
            frame_length=1280,
        )
        emit("ready", wake_word=wake_word_name)

        while True:
            recorder.start()
            emit("listening", wake_word=wake_word_name)
            try:
                while True:
                    audio = np.asarray(recorder.read(), dtype=np.int16)
                    scores = wake_word.predict(audio)
                    if max(scores.values(), default=0.0) >= wake_threshold:
                        break
            finally:
                recorder.stop()

            emit("wake_detected")
            latest_text = ""
            transcription_started_at = time.monotonic()
            last_speech_at = transcription_started_at
            stop_transcription.clear()

            def on_text(text: str) -> None:
                nonlocal latest_text, last_speech_at
                value = value_from_line(text)
                if value:
                    latest_text = value
                    last_speech_at = time.monotonic()
                    emit("transcript", text=value, final=False)

            def on_line(line: Any) -> None:
                nonlocal latest_text, last_speech_at
                value = value_from_line(line)
                if value:
                    latest_text = value
                    last_speech_at = time.monotonic()
                    emit("transcript", text=value, final=True)

            transcriber = (
                MicTranscriber()
                .language(language)
                .model_arch(ModelArch.SMALL_STREAMING)
                .on_text(on_text)
                .on_line(on_line)
            )
            transcriber.load()
            transcriber.start()
            emit("transcribing")

            while not stop_transcription.wait(0.1):
                now = time.monotonic()
                can_finish = now - transcription_started_at >= minimum_transcription_time
                if latest_text and can_finish and now - last_speech_at >= silence_timeout:
                    break

            transcriber.stop()
            transcriber.close()
            if latest_text:
                emit("final", text=latest_text)
            else:
                emit("error", message="No speech was transcribed after wake word")
    except KeyboardInterrupt:
        emit("stopped")
    except Exception as error:
        emit("error", message=f"STT worker failed: {error}")
    finally:
        try:
            recorder.stop()
            recorder.delete()
            wake_word.reset()
        except Exception:
            pass


if __name__ == "__main__":
    run()
