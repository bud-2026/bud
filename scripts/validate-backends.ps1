$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$staging = Join-Path $root 'build\python'
$required = @(
  (Join-Path $staging 'tts\bud-tts-backend\bud-tts-backend.exe'),
  (Join-Path $staging 'stt\bud-stt-backend\bud-stt-backend.exe'),
  (Join-Path $staging 'model-cache')
)

foreach ($path in $required) {
  if (-not (Test-Path $path)) {
    throw "Missing prepared backend resource: $path"
  }
}

Write-Host 'Python backend resources are ready for electron-builder.'
