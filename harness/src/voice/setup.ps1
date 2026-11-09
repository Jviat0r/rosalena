<#
  setup.ps1 - install the accurate local speech-to-text backend for "/voice".

  Creates an isolated Python 3.12 environment next to this file and installs
  faster-whisper into it. Nothing is installed system-wide, no admin rights are
  needed, and no compiler is involved. The model is downloaded and cached on the
  first run so the first real "/voice" does not sit through a download.

  Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
          ... -Model small.en      better accuracy, ~4x slower, ~500 MB
          ... -Force               rebuild the environment from scratch
#>
param(
  [string]$Model = "base.en",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$venv = Join-Path $here ".venv"
$python = Join-Path $venv "Scripts\python.exe"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Output "uv is required but not on PATH (https://docs.astral.sh/uv/)"
  exit 2
}

if ($Force -and (Test-Path $venv)) {
  Write-Output "removing the existing environment"
  Remove-Item $venv -Recurse -Force
}

if (-not (Test-Path $python)) {
  Write-Output "creating an isolated Python 3.12 environment (no system changes)"
  & uv venv --python 3.12 $venv
  if ($LASTEXITCODE -ne 0) { Write-Output "uv venv failed"; exit 2 }
}

Write-Output "installing faster-whisper (this is the slow part, once)"
& uv pip install --python $python faster-whisper
if ($LASTEXITCODE -ne 0) { Write-Output "faster-whisper install failed"; exit 2 }

Write-Output "downloading and caching the '$Model' model"
& $python (Join-Path $here "transcribe.py") --warm --model $Model
if ($LASTEXITCODE -ne 0) { Write-Output "model warm-up failed"; exit 2 }

Write-Output ""
Write-Output "voice input is ready. Try:"
Write-Output '  node src/cli.mjs --voice        (speak every prompt)'
Write-Output '  node src/cli.mjs                (then type /voice)'
exit 0
