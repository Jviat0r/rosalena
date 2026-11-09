<#
  win-speech.ps1 - offline dictation for the harness "/voice" command.

  Uses the speech recognizer already built into Windows (System.Speech), so the
  voice input needs no model download, no API key and no network.

  Modes
    -Mic                listen on the default microphone until the speaker stops
                        (a pause), or -MaxSeconds runs out
    -Wav <path>         recognise an existing WAV file (what the self-test uses)
    -List               print the installed recognizers and exit

  The transcript is written to -Out as UTF-8 with no BOM, and re-written after
  every phrase, so a cancelled or timed-out run still leaves what was heard.
  Pass -Out only when you need the text in a file; otherwise it goes to stdout.

  Exit codes
    0  ok (the transcript may legitimately be empty - nobody spoke)
    2  System.Speech is unavailable
    3  Windows has no speech recognizer installed
#>
param(
  [string]$Out,
  [string]$Wav,
  [switch]$Mic,
  [switch]$List,
  [int]$MaxSeconds = 60,
  [double]$SilenceSeconds = 1.6,
  [double]$InitialSilenceSeconds = 8
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Say-Err([string]$m) { [Console]::Error.WriteLine($m) }

try { Add-Type -AssemblyName System.Speech } catch { Say-Err "System.Speech unavailable"; exit 2 }

$recognizers = @()
try { $recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() } catch { }
if (-not $recognizers -or $recognizers.Count -eq 0) { Say-Err "no speech recognizer installed"; exit 3 }

if ($List) {
  foreach ($r in $recognizers) { Write-Output ("recognizer: {0} [{1}]" -f $r.Id, $r.Culture) }
  exit 0
}

# The parameterless constructor follows the current UI culture; fall back to the
# first installed recognizer when that culture has none.
$engine = $null
try { $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine } catch { }
if (-not $engine) {
  try { $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine -ArgumentList @($recognizers[0]) }
  catch { Say-Err ("could not create a recognizer: " + $_.Exception.Message); exit 3 }
}

$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))

function Write-Transcript([string[]]$parts) {
  $text = ($parts -join " ").Trim()
  if ($Out) { [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($Out), $text, $utf8) }
  else { Write-Output $text }
}

$parts = New-Object System.Collections.Generic.List[string]
if ($Out) { Write-Transcript @() }

$waveMode = $false
try {
  if ($Wav) {
    $waveMode = $true
    $engine.SetInputToWaveFile([System.IO.Path]::GetFullPath($Wav))
  } else {
    $engine.SetInputToDefaultAudioDevice()
  }
} catch {
  Say-Err ("could not open audio input: " + $_.Exception.Message)
  exit 2
}

$clock = [System.Diagnostics.Stopwatch]::StartNew()
$lastHeard = $null
$emptyReads = 0

while ($true) {
  if (-not $waveMode) {
    $elapsed = $clock.Elapsed.TotalSeconds
    if ($elapsed -ge $MaxSeconds) { break }
    if ($null -ne $lastHeard -and ($elapsed - $lastHeard) -ge $SilenceSeconds) { break }
    if ($null -eq $lastHeard -and $elapsed -ge $InitialSilenceSeconds) { break }
  }

  $result = $null
  try {
    if ($waveMode) { $result = $engine.Recognize() }
    else { $result = $engine.Recognize([TimeSpan]::FromSeconds(1.0)) }
  } catch {
    # Reaching the end of a wave file throws here; so does a device that vanished.
    Say-Err ("input finished: " + $_.Exception.Message)
    break
  }

  if ($null -ne $result -and $result.Text) {
    $emptyReads = 0
    $parts.Add($result.Text)
    $lastHeard = $clock.Elapsed.TotalSeconds
    if ($Out) { Write-Transcript $parts.ToArray() }
  } else {
    $emptyReads += 1
    # In wave mode a null means "nothing in that stretch"; two in a row is the end.
    if ($waveMode -and $emptyReads -ge 2) { break }
  }
}

try { $engine.Dispose() } catch { }
Write-Transcript $parts.ToArray()
exit 0
