param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$llamaVersion = 'b10792'
$llamaReleaseUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$llamaVersion"
$llamaArchive = "llama-$llamaVersion-bin-win-cuda-12.4-x64.zip"
$cudartArchive = 'cudart-llama-bin-win-cuda-12.4-x64.zip'
$vlStaging = Join-Path $root 'build\vl'
$vlDownloads = Join-Path $root 'build\vl-download'
$vlBin = Join-Path $vlStaging 'bin'
$serverExecutable = Join-Path $vlBin 'llama-server.exe'

if ((-not $Force) -and (Test-Path $serverExecutable)) {
  Write-Host 'llama.cpp runtime is already prepared.'
  return
}

if (Test-Path $vlStaging) {
  Remove-Item $vlStaging -Recurse -Force
}
New-Item -ItemType Directory -Path $vlStaging, $vlDownloads, $vlBin | Out-Null

function Get-LlamaArchive($name) {
  $destination = Join-Path $vlDownloads $name
  if (-not (Test-Path $destination)) {
    Write-Host "Downloading $name from the llama.cpp releases..."
    Invoke-WebRequest -Uri "$llamaReleaseUrl/$name" -OutFile $destination
  }
  return $destination
}

$llamaZipPath = Get-LlamaArchive $llamaArchive
$cudartZipPath = Get-LlamaArchive $cudartArchive

$extractPath = Join-Path $root 'build\vl-extract'
if (Test-Path $extractPath) {
  Remove-Item $extractPath -Recurse -Force
}
New-Item -ItemType Directory -Path $extractPath | Out-Null
Expand-Archive -Path $llamaZipPath -DestinationPath $extractPath -Force
Expand-Archive -Path $cudartZipPath -DestinationPath $extractPath -Force

# Both archives nest their files in release-specific folders; flatten them into bin.
Get-ChildItem -Path $extractPath -Recurse -File | Copy-Item -Destination $vlBin -Force
Remove-Item $extractPath -Recurse -Force

if (-not (Test-Path $serverExecutable)) {
  throw 'llama-server.exe is missing after extracting the llama.cpp release archives.'
}

Write-Host "llama.cpp runtime is ready for the local Qwen3-VL server ($serverExecutable)."
