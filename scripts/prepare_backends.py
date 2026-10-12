#!/usr/bin/env python3
"""Prepare Bud's bundled speech backends.

Single preparation entrypoint, replacing the previous prepare-backends.ps1,
prepare-vl.ps1 and validate-backends.ps1 scripts. It handles only the work that
cannot be provisioned at runtime:

  * creating the Python virtual environments for the STT/TTS backends
  * installing their dependencies
  * freezing them into PyInstaller one-dir bundles under build/python
  * copying the custom wake-word model into the STT bundle

Model weights (Pocket-TTS, Moonshine, Qwen3-VL) and the llama.cpp runtime are
NOT staged here: the app downloads them on first launch into the user's data
directory, so the installer stays small and the first run needs internet.

Usage (via uv, which resolves Python 3.12):
  uv run --no-project --python 3.12 python scripts/prepare_backends.py
  uv run --no-project --python 3.12 python scripts/prepare_backends.py --dev
  uv run --no-project --python 3.12 python scripts/prepare_backends.py --validate-only

These are wired up as `npm run setup:dev`, `npm run prepare:backends` and
`npm run validate:backends`.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STAGING = ROOT / "build" / "python"
TTS_SOURCE = ROOT / "backend" / "tts"
STT_SOURCE = ROOT / "backend" / "stt"
TTS_VENV = TTS_SOURCE / ".venv"
STT_VENV = STT_SOURCE / ".venv"
WAKE_WORD_MODEL = STT_SOURCE / "models" / "hey_bud.onnx"

PYTHON_VERSION = "3.12"


def venv_python(venv: Path) -> Path:
    if sys.platform == "win32":
        return venv / "Scripts" / "python.exe"
    return venv / "bin" / "python"


def venv_script(venv: Path, name: str) -> Path:
    if sys.platform == "win32":
        return venv / "Scripts" / f"{name}.exe"
    return venv / "bin" / name


def executable_name(name: str) -> str:
    return f"{name}.exe" if sys.platform == "win32" else name


def run(command: list[str]) -> None:
    print(f"$ {' '.join(str(part) for part in command)}", flush=True)
    subprocess.run(command, check=True, cwd=ROOT)


def has_uv() -> bool:
    return shutil.which("uv") is not None


def bootstrap_interpreter() -> list[str]:
    """Command prefix used to create virtual environments without uv."""
    if sys.platform == "win32":
        py_launcher = shutil.which("py")
        if py_launcher:
            return [py_launcher, f"-{PYTHON_VERSION}"]
    return [sys.executable]


def ensure_venv(venv: Path) -> None:
    if venv_python(venv).exists():
        return
    print(f"[prepare] Creating virtual environment at {venv}", flush=True)
    if has_uv():
        run(["uv", "venv", "--python", PYTHON_VERSION, str(venv)])
    else:
        run([*bootstrap_interpreter(), "-m", "venv", str(venv)])


def install_dependencies(venv: Path, source: Path) -> None:
    # PyInstaller is pinned in the TTS requirements but not the STT ones, so it
    # is requested explicitly here to keep both build environments consistent.
    # uv-created environments do not ship pip, so prefer uv's installer when it
    # is available and fall back to pip otherwise.
    requirements = str(source / "requirements.txt")
    if has_uv():
        run(
            [
                "uv",
                "pip",
                "install",
                "--python",
                str(venv_python(venv)),
                "--requirement",
                requirements,
                "pyinstaller",
            ]
        )
    else:
        run(
            [
                str(venv_python(venv)),
                "-m",
                "pip",
                "install",
                "--requirement",
                requirements,
                "pyinstaller",
            ]
        )


def build_bundle(
    venv: Path,
    source: Path,
    name: str,
    collect: list[str],
    output: Path,
    work: str,
) -> None:
    command = [str(venv_script(venv, "pyinstaller"))]
    command += ["--noconfirm", "--clean", "--onedir"]
    for package in collect:
        command += ["--collect-all", package]
    command += [
        "--name",
        name,
        "--distpath",
        str(output),
        "--workpath",
        str(ROOT / "build" / work),
        "--specpath",
        str(ROOT / "build"),
        str(source / "main.py"),
    ]
    run(command)


def validate() -> int:
    required = [
        STAGING / "tts" / "bud-tts-backend" / executable_name("bud-tts-backend"),
        STAGING / "stt" / "bud-stt-backend" / executable_name("bud-stt-backend"),
        STAGING / "stt" / "models" / "hey_bud.onnx",
    ]

    missing = [path for path in required if not path.exists()]
    if missing:
        for path in missing:
            print(f"[validate] Missing prepared backend resource: {path}", file=sys.stderr)
        return 1

    print("[validate] Python backend resources are ready for electron-builder.", flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare Bud's bundled speech backends.")
    parser.add_argument(
        "--dev",
        action="store_true",
        help="Only create the virtual environments and install dependencies.",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Only verify that the staged backend artifacts exist.",
    )
    args = parser.parse_args()

    if args.validate_only:
        return validate()

    if not args.dev and STAGING.exists():
        print(f"[prepare] Cleaning {STAGING}", flush=True)
        shutil.rmtree(STAGING)

    ensure_venv(TTS_VENV)
    ensure_venv(STT_VENV)
    install_dependencies(TTS_VENV, TTS_SOURCE)
    install_dependencies(STT_VENV, STT_SOURCE)

    if args.dev:
        print("[prepare] Dev dependencies are ready. Run `npm run dev`.", flush=True)
        return 0

    STAGING.mkdir(parents=True, exist_ok=True)
    build_bundle(
        TTS_VENV,
        TTS_SOURCE,
        "bud-tts-backend",
        ["pocket_tts", "torch"],
        STAGING / "tts",
        "pyinstaller-tts",
    )
    build_bundle(
        STT_VENV,
        STT_SOURCE,
        "bud-stt-backend",
        ["openwakeword", "moonshine_voice"],
        STAGING / "stt",
        "pyinstaller-stt",
    )

    if WAKE_WORD_MODEL.exists():
        destination = STAGING / "stt" / "models" / "hey_bud.onnx"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(WAKE_WORD_MODEL, destination)
    else:
        print(
            f"[prepare] Warning: custom wake-word model not found at {WAKE_WORD_MODEL}",
            file=sys.stderr,
        )

    return validate()


if __name__ == "__main__":
    raise SystemExit(main())
