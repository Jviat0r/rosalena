// Start a Chromium-based browser for the audit and the pre-render, on any machine:
// CHROME_PATH if set, else Playwright's own Chromium if one is installed, else the Edge,
// Chrome or Brave already on the PC (Edge ships with every Windows 10/11). The same order
// as the ui-check skill's ui-audit.mjs. Replaces a hard-coded path that only existed on
// the machine these scripts were written on.
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export function systemBrowsers () {
  const os = platform()
  if (os === 'win32') {
    const bases = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean)
    return bases.flatMap((base) => [
      join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    ])
  }
  if (os === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ]
  }
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge']
}

export async function launchBrowser (pw, options = {}) {
  const tries = []
  if (process.env.CHROME_PATH) tries.push({ executablePath: process.env.CHROME_PATH })
  tries.push({})
  for (const exe of systemBrowsers()) if (existsSync(exe)) tries.push({ executablePath: exe })
  let last
  for (const opts of tries) {
    try {
      return await pw.chromium.launch({ headless: true, ...options, ...opts })
    } catch (err) {
      last = err
    }
  }
  throw last ?? new Error('no Chromium-based browser found: install Chrome or Edge, or set CHROME_PATH')
}
