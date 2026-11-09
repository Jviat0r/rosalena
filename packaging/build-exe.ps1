# Builds Rosalena-Harness.exe - the launcher - from source.
#
# Uses the .NET Framework C# compiler that ships with Windows, so this needs no
# npm package, no SDK, no internet and no admin rights. Node.js is NOT required
# to build it (only to run the harness it launches, and only in CLI mode).
#
#   powershell -ExecutionPolicy Bypass -File packaging\build-exe.ps1
#
# Output: bin\Rosalena-Harness.exe, the dev launcher (it runs this checkout's source).
# The product root holds shortcuts instead, made per machine and not committed: "Rosalena
# Harness" opens the installed release, "Rosalena Harness (dev source)" opens this launcher
# (packaging\make-shortcuts.ps1). The launcher derives the layout from its own path.
#
# The binary is a GUI (Windows) subsystem binary - /target:winexe - so Windows allocates
# no console for it at all. A double-click shows the window and nothing else: no black
# window behind the app, nothing that flashes and disappears. The launcher's own output
# and the child's go to <data>\logs\launcher.log (see the .cs header); from a terminal,
# the launcher attaches to that terminal and mirrors them, and `--log` prints the file.
#
# The icon is packaging\assets\rosalena.ico, embedded with /win32icon. It is generated
# by packaging\tools\make-icon.mjs (no dependencies; `node packaging\tools\make-icon.mjs`
# to regenerate) and committed, because this build must not require Node.js. The script
# checks that the built exe really carries it and really is a GUI subsystem binary,
# rather than assuming the compiler flags did what they say.
#
# What it starts: with no arguments it opens the desktop window (desktop\, an
# Electron app - it must have been `npm install`ed once, and the runtime is
# discovered at run time, not bundled here); with arguments it runs the Node CLI.
# --launcher-info reports both, which is why the smoke test below checks the
# desktop line as well as the harness line.

$ErrorActionPreference = "Stop"

$packaging = Split-Path -Parent $MyInvocation.MyCommand.Path
$product   = Split-Path -Parent $packaging
$source    = Join-Path $packaging "launcher\RosalenaHarness.cs"
$icon      = Join-Path $packaging "assets\rosalena.ico"
$binDir    = Join-Path $product "bin"
$output    = Join-Path $binDir "Rosalena-Harness.exe"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

Write-Host "Rosalena Harness - building the launcher"
Write-Host "  product  $product"
Write-Host "  source   $source"
Write-Host "  icon     $icon"
Write-Host "  output   $output"
Write-Host ""

if (-not (Test-Path $source)) { Write-Error "missing source: $source"; exit 1 }
if (-not (Test-Path $icon)) {
  Write-Error @"
missing icon: $icon
  the icon is a committed artifact (this build must not need Node.js).
  regenerate it once with:  node packaging\tools\make-icon.mjs
"@
  exit 1
}
if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir | Out-Null }

# The in-box compiler. Framework64 first (64-bit box), then the 32-bit path.
$candidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $null
foreach ($c in $candidates) { if (Test-Path $c) { $csc = $c; break } }
if ($null -eq $csc) {
  Write-Error "no in-box C# compiler found (looked in $($candidates -join ', '))"
  exit 1
}
Write-Host "  compiler $csc"
Write-Host ""

# /target:winexe      GUI subsystem: Windows allocates no console, so no console window
#                     can appear or flash. The launcher writes to its log file, and to
#                     the terminal it attaches to when it was started from one.
# /win32icon:         the Rosalena mark, as the exe's own icon (Explorer, taskbar, dialogs)
# /platform:anycpu    runs on 64-bit and 32-bit Windows alike
# /optimize+          this is the copy people actually run
& $csc /nologo /target:winexe /platform:anycpu /optimize+ /win32icon:"$icon" /out:"$output" "$source"
if ($LASTEXITCODE -ne 0) { Write-Error "compilation failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }

$exe = Get-Item $output
Write-Host ""
Write-Host ("built {0} ({1:N0} bytes) at {2}" -f $exe.Name, $exe.Length, $exe.LastWriteTime)

# --- verify what was just built, instead of trusting the flags -------------------
#
# The PE optional header's Subsystem field: 2 = Windows GUI, 3 = console. This is the
# measurement behind "no console window appears".
function Get-PeSubsystem([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  # COFF header (20 bytes) then the optional header, whose Subsystem field is at +68
  # for both PE32 and PE32+.
  return [BitConverter]::ToUInt16($bytes, $peOffset + 4 + 20 + 68)
}

$subsystem = Get-PeSubsystem $output
if ($subsystem -ne 2) {
  Write-Error "the build is subsystem $subsystem, expected 2 (Windows GUI). A console subsystem build gets a console window."
  exit 1
}
Write-Host "verified subsystem 2 (Windows GUI - no console window is allocated for this exe)"

# The icon has to be *in* the exe. The 256 px image is a PNG inside the .ico, and csc
# copies each image byte for byte into the exe's resources, so finding a slice of that
# PNG in the exe is proof the icon is embedded (and not, say, a default empty resource).
function Get-IconImage([string]$IcoPath, [int]$Size) {
  $bytes = [System.IO.File]::ReadAllBytes($IcoPath)
  $count = [BitConverter]::ToUInt16($bytes, 4)
  for ($i = 0; $i -lt $count; $i++) {
    $at = 6 + ($i * 16)
    $width = if ($bytes[$at] -eq 0) { 256 } else { $bytes[$at] }
    if ($width -ne $Size) { continue }
    $length = [int][BitConverter]::ToUInt32($bytes, $at + 8)
    $offset = [int][BitConverter]::ToUInt32($bytes, $at + 12)
    $image = New-Object byte[] $length
    [Array]::Copy($bytes, $offset, $image, 0, $length)
    return $image
  }
  return $null
}

$iconImage = Get-IconImage $icon 256
if ($null -eq $iconImage) { Write-Error "the .ico has no 256 px image: $icon"; exit 1 }
$probe = New-Object byte[] 48
[Array]::Copy($iconImage, 64, $probe, 0, 48)
$latin1 = [System.Text.Encoding]::GetEncoding(28591)
$exeText = $latin1.GetString([System.IO.File]::ReadAllBytes($output))
$foundAt = $exeText.IndexOf($latin1.GetString($probe), [StringComparison]::Ordinal)
if ($foundAt -lt 0) {
  Write-Error "the built exe does not contain the 256 px icon image - /win32icon did not embed it"
  exit 1
}
Write-Host ("verified the icon is embedded (256 px PNG image found at byte {0})" -f $foundAt)

# --- smoke test -----------------------------------------------------------------
#
# A GUI subsystem binary has no stdio, so `& $exe --launcher-info` would not print
# anything and would not even wait (PowerShell does not wait for GUI applications).
# Redirecting the child's stdout is what makes the report readable, and it is also the
# code path a caller in a script uses.
$tempDir = [System.IO.Path]::GetTempPath()
function Invoke-Launcher([string]$Exe, [string[]]$Arguments, [string]$Tag) {
  $out = Join-Path $tempDir ("rosalena-{0}.out.txt" -f $Tag)
  $err = Join-Path $tempDir ("rosalena-{0}.err.txt" -f $Tag)
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  $started = Start-Process -FilePath $Exe -ArgumentList $Arguments -Wait -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  return [pscustomobject]@{
    ExitCode = $started.ExitCode
    Lines    = @(if (Test-Path $out) { Get-Content -LiteralPath $out } else { @() })
    Errors   = @(if (Test-Path $err) { Get-Content -LiteralPath $err } else { @() })
  }
}

Write-Host ""
Write-Host "smoke test: --launcher-info"
$bin = Invoke-Launcher $output @("--launcher-info", "--no-dialog") "launcher-info-bin"
$bin.Lines | ForEach-Object { Write-Host $_ }
if ($bin.ExitCode -ne 0) {
  $bin.Errors | ForEach-Object { Write-Host $_ }
  Write-Error "the launcher could not resolve its runtime (exit $($bin.ExitCode))"
  exit $bin.ExitCode
}

# A launcher that cannot find its own window is the bug this build must not ship,
# so the desktop line is checked, not just printed.
if (-not ($bin.Lines | Where-Object { $_ -match "^\s+desktop\s" })) {
  Write-Error "--launcher-info printed no desktop line; the launcher cannot find its window"
  exit 1
}

Write-Host ""
Write-Host "smoke test: --check (needs the router on 127.0.0.1:8077 for a full report)"
$check = Invoke-Launcher $output @("--check", "--no-dialog") "check"
$check.Lines | Select-Object -Last 25 | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "(the check exited $($check.ExitCode); 0 means the router answered)"
Write-Host ""
Write-Host "done: $output is a GUI subsystem binary with the Rosalena icon embedded"
