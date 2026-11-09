<#
  selftest.ps1 - proves the voice pipeline transcribes real audio with no
  microphone and no network.

  It speaks a known sentence through the Windows speech synthesizer into a WAV
  file, then hands that file to win-speech.ps1 and checks the words came back.
  That exercises the whole speech-to-text half of "/voice" on any machine, mic or
  not. Only the microphone capture itself needs a human to speak.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File selftest.ps1
#>
param([string]$Work = "$env:TEMP\harness-voice-selftest", [switch]$SynthOnly)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$wav = Join-Path $Work "spoken.wav"
$out = Join-Path $Work "heard.txt"

$phrase = "add a json flag to the export command"
$words = $phrase -split "\s+"

Write-Output "voice self-test"
Write-Output ("  work dir   " + $Work)

# 1. Synthesize the phrase to a file - a stand-in for a person talking.
try { Add-Type -AssemblyName System.Speech } catch { Write-Output "  FAIL: System.Speech unavailable"; exit 2 }
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile($wav)
$synth.Speak($phrase)
$synth.Dispose()
if (-not (Test-Path $wav)) { Write-Output "  FAIL: synthesizer produced no audio"; exit 2 }
$kb = [Math]::Round((Get-Item $wav).Length / 1KB, 1)
Write-Output ("  spoke      `"$phrase`"  ($kb KB)")

# The Node test suite asks only for the recording, then feeds it to each engine.
if ($SynthOnly) { Write-Output $wav; exit 0 }

# 2. Transcribe it back.
$started = Get-Date
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "win-speech.ps1") -Wav $wav -Out $out
$code = $LASTEXITCODE
$ms = [Math]::Round(((Get-Date) - $started).TotalMilliseconds)
if ($code -ne 0) { Write-Output ("  FAIL: win-speech.ps1 exited " + $code); exit $code }

$heard = ""
if (Test-Path $out) { $heard = (Get-Content $out -Raw).Trim() }
Write-Output ("  heard      `"$heard`"  ({0}ms)" -f $ms)

# 3. Did the words survive? Report which ones, not just pass/fail: a recognizer
#    that is merely inaccurate should look different from one that is broken.
$heardWords = @($heard.ToLower() -split "[^a-z0-9]+" | Where-Object { $_ })
$hits = @($words | Where-Object { $heardWords -contains $_.ToLower() })
$missed = @($words | Where-Object { $heardWords -notcontains $_.ToLower() })
Write-Output ("  matched    {0}/{1} words" -f $hits.Count, $words.Count)
if ($missed.Count) { Write-Output ("  missing    " + ($missed -join ", ")) }

if ($hits.Count -ge [Math]::Ceiling($words.Count / 2)) {
  Write-Output "  PASS       speech-to-text works on this machine"
  exit 0
}
Write-Output "  FAIL       too few words recognised - check the recognizer language pack"
exit 1
