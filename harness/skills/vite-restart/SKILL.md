---
name: vite-restart
description: Safe rebuild-to-preview workflow for Vite apps on Windows. Use after ANY build that changes hashed assets, whenever restarting `vite preview`, or when the served page might be stale. Port-based kill, cmd-shim launch, HTTP wait-loop, and dist-hash verification — never fixed sleeps, never trust a bare "listening pid". Pairs with anti-stuck.
---

# Vite Preview Restart (no-stuck)

Goal: after a rebuild, the browser the user is looking at must be proven to be serving the NEW build — not assumed.

## Why the naive flow fails (all observed on this machine)

1. **Fixed sleep after launch is a lie.** `Start-Sleep 4` then check the port: `npx vite preview` is launched through a `.cmd` shim chain (npx.cmd → node), which can take >4s cold. The check reports "nothing listening" and you re-launch a SECOND server that can't bind (port busy) or, worse, the FIRST one comes up later and you now have two processes and no idea which one is serving.
2. **`npx` is not a Win32 binary.** `Start-Process -FilePath "npx"` fails with "%1 is not a valid Win32 application". Launch via `cmd /c "npx vite preview --port <port>"`.
3. **Bash mangles PowerShell `$_`.** In bash double-quotes, `$_` expands to the last argument of the previous command (e.g. `/usr/bin/bash`) before PowerShell ever sees it. Write the script to a `.ps1` file and run `powershell -NoProfile -ExecutionPolicy Bypass -File <script>`. Never inline PowerShell containing `$_` in a bash command.
4. **Stale index.html incident.** A long-lived preview process served an old `index.html` referencing a deleted CSS hash (`index-BpFIJItM.css`) even after the dist was rebuilt, because the process had cached the file listing / the HTML was resolved at boot. "The port is listening" ≠ "the page is fresh". You MUST verify the served HTML's asset hashes exist in `dist/`.
5. **Browser-side caching.** Even with a correct server, the tab holds the old JS/CSS. Cache-bust every reload: append `?v=<N>` (incrementing counter) to the URL.

## The script (proven, keep it in a file)

Write it to `%TEMP%\rosalena\restart-preview.ps1` and set `$project` and `$port` at the top:

```powershell
$ErrorActionPreference = "Stop"
$project = "<path to the Vite project>"
$port = 4173
$logs = Join-Path $env:TEMP "rosalena"
New-Item -ItemType Directory -Force $logs | Out-Null
# 1. kill whatever owns the port (by PID from the port — never by process name)
$p = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
if ($p) {
  foreach ($id in $p) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; Write-Output "killed $id" }
  Start-Sleep -Seconds 1
}
# 2. launch through cmd (npx is a .cmd shim)
Start-Process -FilePath "cmd" -ArgumentList "/c","npx vite preview --port $port" `
  -WorkingDirectory $project `
  -RedirectStandardOutput (Join-Path $logs "vite-preview.log") `
  -RedirectStandardError (Join-Path $logs "vite-preview-err.log") `
  -WindowStyle Hidden
# 3. wait-loop: up to 20s, poll real HTTP (not just port state)
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$port/" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
if (-not $ok) { Write-Output "FAIL: preview did not come up in 20s"; exit 1 }
# 4. anti-stale check: every CSS hash referenced by the served HTML must exist in dist
$html = (Invoke-WebRequest -Uri "http://localhost:$port/" -UseBasicParsing).Content
$hashes = [regex]::Matches($html, 'assets/index-[A-Za-z0-9_-]+\.css') | ForEach-Object { $_.Value }
Write-Output "served css refs: $hashes"
$missing = @($hashes | Where-Object { -not (Test-Path (Join-Path $project "dist\$_")) })
if ($missing) { Write-Output "FAIL: served HTML references missing dist files: $missing"; exit 1 }
$listener = (Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique) -join ","
Write-Output "OK: preview serving correct build, pid $listener"
```

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\rosalena\restart-preview.ps1"`

Success = the final line is `OK: preview serving correct build, pid <n>`. Anything else (FAIL, exception, no output) is a failure.

## In-page confirmation (do this too, once, per goal)

In the browser: open `http://localhost:4173/#/?v=<N>` (bump N every time) then:

```js
page.evaluate(() => {
  const l = document.querySelector('link[rel="stylesheet"]');
  return { href: l && l.href, title: document.title };
})
```

The href must match the fresh `dist/assets/index-*.css` hash. Mismatch → the tab or the server is stale; re-kill and re-run the script before debugging anything else.

## Failure handling (2-minute rule, from anti-stuck)

- Script exits 1 with "did not come up in 20s": read `vite-preview-err.log` (port-in-use means the kill missed a child node process — kill it: `Get-Process node | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match 'vite' } | Stop-Process -Force`), then re-run ONCE.
- Same failure twice: stop. Surface state (port, PIDs, log tails) to the user instead of a third identical attempt.
- Never `npx vite preview` in a bare `&` bash background job as the primary mechanism — it works, but you lose the wait-loop and the hash verification, which is exactly how the stale-HTML incident happened.
