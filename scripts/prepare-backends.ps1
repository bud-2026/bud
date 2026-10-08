$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$staging = Join-Path $root 'build\python'
$ttsSource = Join-Path $root 'backend\tts'
$sttSource = Join-Path $root 'backend\stt'
$ttsVenv = Join-Path $root 'backend\tts\.venv'
$sttVenv = Join-Path $root 'backend\stt\.venv'
$cache = Join-Path $staging 'model-cache'

if (Test-Path $staging) {
  Remove-Item $staging -Recurse -Force
}
New-Item -ItemType Directory -Path $staging, $cache | Out-Null

function Ensure-Venv($path) {
  if (-not (Test-Path (Join-Path $path 'Scripts\python.exe'))) {
    py -3.12 -m venv $path
  }
}

Ensure-Venv $ttsVenv
Ensure-Venv $sttVenv

& (Join-Path $ttsVenv 'Scripts\python.exe') -m pip install -r (Join-Path $ttsSource 'requirements.txt') pyinstaller
& (Join-Path $sttVenv 'Scripts\python.exe') -m pip install -r (Join-Path $sttSource 'requirements.txt') pyinstaller

$env:HF_HOME = $cache
$env:TRANSFORMERS_CACHE = $cache
& (Join-Path $ttsVenv 'Scripts\python.exe') -c "from pocket_tts import TTSModel; TTSModel.load_model()"
& (Join-Path $sttVenv 'Scripts\python.exe') -c "import openwakeword; from openwakeword.utils import download_models; download_models(['hey_mycroft'])"
& (Join-Path $sttVenv 'Scripts\python.exe') -c "from moonshine_voice import MicTranscriber, ModelArch; transcriber = MicTranscriber().language('en').model_arch(ModelArch.SMALL_STREAMING); transcriber.load(); transcriber.close()"

$ttsOutput = Join-Path $staging 'tts'
$sttOutput = Join-Path $staging 'stt'
& (Join-Path $ttsVenv 'Scripts\pyinstaller.exe') --noconfirm --clean --onedir --collect-all pocket_tts --collect-all torch --name bud-tts-backend --distpath $ttsOutput --workpath (Join-Path $root 'build\pyinstaller-tts') --specpath (Join-Path $root 'build') (Join-Path $ttsSource 'main.py')
& (Join-Path $sttVenv 'Scripts\pyinstaller.exe') --noconfirm --clean --onedir --collect-all openwakeword --collect-all moonshine_voice --name bud-stt-backend --distpath $sttOutput --workpath (Join-Path $root 'build\pyinstaller-stt') --specpath (Join-Path $root 'build') (Join-Path $sttSource 'main.py')

$customModel = Join-Path $sttSource 'models\hey_bud.onnx'
if (Test-Path $customModel) {
  New-Item -ItemType Directory -Path (Join-Path $staging 'stt\models') -Force | Out-Null
  Copy-Item $customModel (Join-Path $staging 'stt\models\hey_bud.onnx')
}
