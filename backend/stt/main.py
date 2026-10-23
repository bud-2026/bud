import json
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any


def emit(event: str, **data: Any) -> None:
    print(json.dumps({"event": event, **data}), flush=True)


def listen_for_commands(
    stop_transcription: threading.Event,
    stop_session: threading.Event,
    auto_listen: threading.Event,
) -> None:
    for line in sys.stdin:
        try:
            command = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(command, dict):
            continue
        name = command.get("command")
        if name == "stop_session":
            stop_session.set()
            stop_transcription.set()
        elif name == "set_mode":
            if command.get("mode") == "continuous":
                auto_listen.set()
            else:
                auto_listen.clear()


def value_from_line(line: Any) -> str:
    if isinstance(line, str):
        return line.strip()
    if isinstance(line, dict):
        return str(line.get("text", "")).strip()
    return str(getattr(line, "text", "")).strip()


def remove_wake_word_prefix(text: str, wake_word: str) -> str:
    normalized_text = " ".join(text.lower().split())
    normalized_wake_word = " ".join(wake_word.lower().split())
    if normalized_text and normalized_wake_word.startswith(normalized_text):
        return ""

    pattern = rf"^\s*{re.escape(wake_word)}(?:[\s,!.?:;-]+|$)"
    return re.sub(pattern, "", text, count=1, flags=re.IGNORECASE).strip()


def is_stop_phrase(text: str, stop_phrases: set[str]) -> bool:
    normalized = " ".join(text.lower().strip().split()).rstrip(".,!?;:")
    return any(
        normalized == phrase or normalized.endswith(f" {phrase}")
        for phrase in stop_phrases
    )


def resolve_wake_word_model() -> tuple[Path, str]:
    model_candidates = (
        Path.cwd() / "models" / "hey_bud.onnx",
        Path(__file__).resolve().parent / "models" / "hey_bud.onnx",
        Path(__file__).resolve().parents[2] / "backend" / "stt" / "models" / "hey_bud.onnx",
    )
    model_file = next((candidate for candidate in model_candidates if candidate.exists()), None)

    if model_file is not None:
        return model_file, "hey bud"

    fallback_name = "hey_mycroft"
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
            phase="downloading",
            message=f"Downloading local fallback wake word model '{fallback_name}'..."
        )
        download_models([fallback_name])
    if not fallback_file.exists():
        raise FileNotFoundError(f"Fallback wake-word model was not installed: {fallback_file}")

    return fallback_file, fallback_name.replace("_", " ")


def warm_up_transcriber(MicTranscriber: Any, ModelArch: Any, language: str) -> None:
    """Pre-loads the transcription model so speech-to-text is ready before the
    first wake word and its download/load state is visible to the UI."""
    emit("status", phase="loading", message="Loading speech-to-text model...")
    transcriber = MicTranscriber().language(language).model_arch(ModelArch.SMALL_STREAMING)
    try:
        transcriber.load()
    finally:
        try:
            transcriber.close()
        except Exception:
            pass


def run() -> None:
    try:
        import numpy as np
        from openwakeword.model import Model as WakeWordModel
        from pvrecorder import PvRecorder
        from moonshine_voice import MicTranscriber, ModelArch
    except ImportError as error:
        emit("error", message=f"STT dependency is missing: {error}")
        return

    silence_timeout = 1.5
    minimum_transcription_time = 1.5
    wake_threshold = 0.85
    wake_confirmation_frames = 5
    stop_phrases = {"thank you", "thanks", "stop", "that's all", "goodbye"}
    language = "en"
    latest_text = ""
    last_speech_at = 0.0
    stop_transcription = threading.Event()
    stop_session = threading.Event()
    auto_listen = threading.Event()
    threading.Thread(
        target=listen_for_commands,
        args=(stop_transcription, stop_session, auto_listen),
        daemon=True,
    ).start()

    try:
        model_file, wake_word_name = resolve_wake_word_model()
        wake_word = WakeWordModel(
            wakeword_models=[str(model_file)],
            inference_framework="onnx",
        )
        recorder = PvRecorder(
            device_index=-1,
            frame_length=1280,
        )
        emit("ready", wake_word=wake_word_name)

        # Pre-load the transcription model so speech-to-text is ready before the
        # first wake word; a failure is reported but does not stop wake listening.
        try:
            warm_up_transcriber(MicTranscriber, ModelArch, language)
            emit("status", phase="ready", message="Speech-to-text model ready")
        except Exception as error:
            emit(
                "status",
                phase="error",
                message=f"Speech-to-text model failed to load: {error}",
            )

        while True:
            started_by_wake = False
            if auto_listen.is_set():
                emit("listening", auto=True)
            else:
                recorder.start()
                emit("listening", wake_word=wake_word_name)
                wake_confirmations = 0
                try:
                    while True:
                        audio = np.asarray(recorder.read(), dtype=np.int16)
                        if auto_listen.is_set():
                            break
                        scores = wake_word.predict(audio)
                        if max(scores.values(), default=0.0) >= wake_threshold:
                            wake_confirmations += 1
                        else:
                            wake_confirmations = 0
                        if wake_confirmations >= wake_confirmation_frames:
                            started_by_wake = True
                            break
                finally:
                    recorder.stop()

                if started_by_wake:
                    time.sleep(0.15)
                    emit("wake_detected")

            conversation_active = True
            while conversation_active:
                latest_text = ""
                transcription_started_at = time.monotonic()
                last_speech_at = transcription_started_at
                completed_lines: list[str] = []
                first_turn = True
                stop_transcription.clear()

                def update_transcript(value: str, final: bool) -> None:
                    nonlocal first_turn, latest_text, last_speech_at
                    if not value:
                        return

                    if first_turn:
                        if started_by_wake:
                            value = remove_wake_word_prefix(value, wake_word_name)
                            if not value:
                                return
                        first_turn = False

                    if final:
                        completed_lines.append(value)
                        transcript = " ".join(completed_lines)
                    else:
                        transcript = " ".join([*completed_lines, value])

                    latest_text = transcript
                    last_speech_at = time.monotonic()
                    emit("transcript", text=transcript, final=final)

                def on_text(text: str) -> None:
                    update_transcript(value_from_line(text), final=False)

                def on_line(line: Any) -> None:
                    update_transcript(value_from_line(line), final=True)

                transcriber = (
                    MicTranscriber()
                    .language(language)
                    .model_arch(ModelArch.SMALL_STREAMING)
                    .update_interval(0.25)
                    .on_text(on_text)
                    .on_line(on_line)
                )
                emit("status", phase="loading", message="Loading speech-to-text model...")
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
                if stop_session.is_set():
                    stop_session.clear()
                    emit("conversation_ended")
                    conversation_active = False
                    continue
                if not latest_text:
                    emit("error", message="No speech was transcribed")
                    conversation_active = False
                    continue

                should_end_conversation = is_stop_phrase(latest_text, stop_phrases)
                emit("final", text=latest_text, end_session=should_end_conversation)
                if should_end_conversation:
                    if auto_listen.is_set():
                        auto_listen.clear()
                    emit("conversation_ended")
                    conversation_active = False
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
