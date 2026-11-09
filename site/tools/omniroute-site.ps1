# omniroute-site.ps1 - put OmniRoute back behind the website after a restart.
#
#   powershell -ExecutionPolicy Bypass -File site\tools\omniroute-site.ps1
#
# 1. Starts OmniRoute on 127.0.0.1:20128 if nothing answers there (its own launcher, loopback
#    only; started without PORT/HOSTNAME it would listen on 0.0.0.0:3000, the whole network).
# 2. Starts the gate + Cloudflare quick tunnel (omniroute-tunnel.mjs --set-secret), which
#    stores the new tunnel address as the OMNIROUTE_URL secret.
# 3. Redeploys the site so the secret takes effect.
# Both processes keep running after this window closes; a reboot stops them again.
# Windows PowerShell 5.1 compatible. ASCII only.

$ErrorActionPreference = 'Stop'
$Site = Split-Path -Parent $PSScriptRoot
$Log = Join-Path $Site '.wrangler\omniroute-tunnel.log'
$Err = Join-Path $Site '.wrangler\omniroute-tunnel.err.log'
$Candidates = @(
  (Join-Path $env:USERPROFILE '.rosalena\omniroute\node_modules\omniroute\bin\omniroute.mjs'),
  'D:\Tools\omniroute\node_modules\omniroute\bin\omniroute.mjs'
)

function Test-Omni {
  try { Invoke-WebRequest -Uri 'http://127.0.0.1:20128/v1/models' -UseBasicParsing -TimeoutSec 3 | Out-Null; return $true }
  catch { if ($_.Exception.Response) { return $true } else { return $false } }
}

$key = [Environment]::GetEnvironmentVariable('OMNIROUTE_API_KEY', 'User')
if (-not $key) { Write-Output 'OMNIROUTE_API_KEY is not set for this user; set it first (setx OMNIROUTE_API_KEY ...)'; exit 1 }
$env:OMNIROUTE_API_KEY = $key

if (Test-Omni) { Write-Output 'OmniRoute already answers on :20128' }
else {
  $bin = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $bin) { Write-Output 'OmniRoute is not installed (Rosalena Settings > Cloud models can install it)'; exit 1 }
  $env:PORT = '20128'; $env:HOSTNAME = '127.0.0.1'
  # Hidden, not a console window in the taskbar. No output redirection: with it, node would
  # share this window's console and die when the window closed. Rosalena itself now starts
  # OmniRoute as its own windowless child (Settings > Cloud models, where its log is), and
  # can take over this copy with "Run it inside Rosalena".
  Start-Process -FilePath 'node' -ArgumentList ('"' + $bin + '" --no-open') -WorkingDirectory (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $bin)))) -WindowStyle Hidden | Out-Null
  $up = $false
  for ($i = 0; $i -lt 45; $i++) { Start-Sleep -Seconds 2; if (Test-Omni) { $up = $true; break } }
  if (-not $up) { Write-Output 'OmniRoute did not answer within 90 s'; exit 1 }
  Write-Output 'OmniRoute started on 127.0.0.1:20128'
}

$gate = Get-NetTCPConnection -LocalPort 20140 -State Listen -ErrorAction SilentlyContinue
if ($gate) { Write-Output 'A tunnel gate is already running on :20140; stop it first if its address is stale'; exit 1 }
if (Test-Path $Log) { Remove-Item $Log -Force }
$tool = Join-Path $PSScriptRoot 'omniroute-tunnel.mjs'
Start-Process -FilePath 'node' -ArgumentList ('"' + $tool + '"'), '--set-secret' -WorkingDirectory $Site -RedirectStandardOutput $Log -RedirectStandardError $Err -WindowStyle Hidden | Out-Null
$done = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  $text = ''
  if (Test-Path $Log) { $text = Get-Content $Log -Raw }
  if ($text -match 'OMNIROUTE_URL updated') { $done = $true; break }
  if ($text -match 'wrangler exited|cloudflared exited') { break }
}
if (Test-Path $Log) { Get-Content $Log | Where-Object { $_ -match '^(gate|tunnel|secret)' } }
if (-not $done) { Write-Output ('The tunnel or the secret did not finish; see ' + $Log + ' and ' + $Err); exit 1 }

Push-Location $Site
try { & npx wrangler pages deploy public --project-name rosalena --branch main --commit-dirty=true }
finally { Pop-Location }
Write-Output 'Done: the site asks OmniRoute after the free window, and Llama after that.'
