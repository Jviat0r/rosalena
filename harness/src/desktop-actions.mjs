// Desktop actions: each builds a short script after the prelude and runs it in one
// windowless PowerShell. Coordinates are physical pixels on the virtual screen, or, when
// a window is named, pixels from that window's top-left corner.
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRELUDE } from "./desktop-ps.mjs";

const q = (s) => `'${String(s ?? "").replace(/'/g, "''")}'`;
const int = (v, name) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};

export function runPs(body, { timeoutMs = 30000 } = {}) {
  if (process.platform !== "win32") return Promise.reject(new Error("desktop control is built for Windows; this machine is " + process.platform));
  // A script file, not stdin: `-Command -` runs stdin line by line, and a multi-line
  // block (an if or for over several lines) is cut at the first line break.
  const script = join(tmpdir(), `rosalena-desktop-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  writeFileSync(script, `\uFEFF${PRELUDE}\n${body}\n`, "utf8");
  const cleanup = () => rmSync(script, { force: true });
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`desktop action timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      if (code !== 0) return reject(new Error((err || out).trim().split("\n").slice(-4).join(" ") || `exit ${code}`));
      resolve(out.trim());
    });
  });
}

/** Script fragment: $ox,$oy = origin; focuses and offsets by the window when one is named. */
function origin(window) {
  // The whole screen is the virtual desktop, whose top-left can be left of or above the
  // primary monitor (a second screen on the left starts at -1920): coordinates read off a
  // full screenshot are measured from there, so clicks are too (bug hunt 2026-11-08).
  if (!window) return `$ox = [RosDesk]::GetSystemMetrics(76); $oy = [RosDesk]::GetSystemMetrics(77)`;
  return `$w = @(Find-Win ${q(window)}) | Select -First 1
if (-not $w) { throw "no visible window titled like ${String(window).replace(/"/g, "'")}" }
Focus-Win $w.h; $r = Win-Rect $w.h; $ox = $r.L; $oy = $r.T`;
}

export function listWindows() {
  return runPs(`$fg = [RosDesk]::GetForegroundWindow()
Find-Win '' | %{ $r = Win-Rect $_.h; if (($r.R - $r.L) -gt 40) { '{0}{1} [{2}] at {3},{4} size {5}x{6}' -f $(if ($_.h -eq $fg) { '* ' } else { '  ' }), $_.title, $_.process, $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T) } }`);
}

export function screenshot({ file, window, maxWidth = 1600, region = null }) {
  let area = window
    ? `${origin(window)}; $x = $r.L; $y = $r.T; $wd = $r.R - $r.L; $ht = $r.B - $r.T`
    : `$x = [RosDesk]::GetSystemMetrics(76); $y = [RosDesk]::GetSystemMetrics(77); $wd = [RosDesk]::GetSystemMetrics(78); $ht = [RosDesk]::GetSystemMetrics(79)`;
  // A part of it (desktop_zoom): real pixels from the same origin, clipped to the area.
  if (region) {
    area += `
$rx = [Math]::Max(0, ${int(region.x, "x")}); $ry = [Math]::Max(0, ${int(region.y, "y")})
$rw = [Math]::Max(8, [Math]::Min(${int(region.width, "width")}, $wd - $rx)); $rh = [Math]::Max(8, [Math]::Min(${int(region.height, "height")}, $ht - $ry))
$x = $x + $rx; $y = $y + $ry; $wd = $rw; $ht = $rh`;
  }
  return runPs(`${area}
$bmp = New-Object System.Drawing.Bitmap $wd, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size); $g.Dispose()
$scale = [Math]::Min(1.0, ${int(maxWidth, "maxWidth")} / $wd)
if ($scale -lt 1.0) {
  $sw = [int]($wd * $scale); $sh = [int]($ht * $scale)
  $small = New-Object System.Drawing.Bitmap $sw, $sh
  $g2 = [System.Drawing.Graphics]::FromImage($small); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($bmp, 0, 0, $sw, $sh); $g2.Dispose()
  $bmp.Dispose(); $bmp = $small
}
$bmp.Save(${q(file)}, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
[string]::Format([cultureinfo]::InvariantCulture, '{0};{1};{2};{3};{4}', $x, $y, $wd, $ht, $scale)`).then((line) => {
    // Invariant culture and ';': on a German or French Windows "0.8333" prints as "0,8333",
    // which split on "," read as scale 0, then 1 - every click on a downscaled shot missed.
    const [x, y, width, height, scale] = line.split(/\r?\n/).pop().split(";").map(Number);
    return { x, y, width, height, scale };
  });
}

const BUTTONS = { left: [0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] };

export function click({ x, y, button = "left", double = false, window }) {
  const [down, up] = BUTTONS[button] ?? BUTTONS.left;
  const once = `[RosDesk]::Mouse(${down}, 0); Start-Sleep -Milliseconds 30; [RosDesk]::Mouse(${up}, 0)`;
  return runPs(`${origin(window)}
[void][RosDesk]::SetCursorPos($ox + ${int(x, "x")}, $oy + ${int(y, "y")}); Start-Sleep -Milliseconds 60
${once}${double ? `; Start-Sleep -Milliseconds 80; ${once}` : ""}
'ok'`);
}

export function drag({ from_x, from_y, to_x, to_y, button = "left", window, steps = 20 }) {
  const [down, up] = BUTTONS[button] ?? BUTTONS.left;
  const n = Math.max(2, Math.min(100, int(steps, "steps")));
  return runPs(`${origin(window)}
$fx = $ox + ${int(from_x, "from_x")}; $fy = $oy + ${int(from_y, "from_y")}; $tx = $ox + ${int(to_x, "to_x")}; $ty = $oy + ${int(to_y, "to_y")}
[void][RosDesk]::SetCursorPos($fx, $fy); Start-Sleep -Milliseconds 60
[RosDesk]::Mouse(${down}, 0); Start-Sleep -Milliseconds 60
for ($i = 1; $i -le ${n}; $i++) { [void][RosDesk]::SetCursorPos([int]($fx + ($tx - $fx) * $i / ${n}), [int]($fy + ($ty - $fy) * $i / ${n})); Start-Sleep -Milliseconds 12 }
Start-Sleep -Milliseconds 60; [RosDesk]::Mouse(${up}, 0)
'ok'`);
}

/** Move the pointer without clicking: hover menus, tooltips, highlight a target. */
export function movePointer({ x, y, window }) {
  return runPs(`${origin(window)}
[void][RosDesk]::SetCursorPos($ox + ${int(x, "x")}, $oy + ${int(y, "y")})
'ok'`);
}

export function scroll({ x, y, amount = -3, window }) {
  const move = x === undefined || y === undefined ? "" : `[void][RosDesk]::SetCursorPos($ox + ${int(x, "x")}, $oy + ${int(y, "y")}); Start-Sleep -Milliseconds 40`;
  return runPs(`${origin(window)}
${move}
[RosDesk]::Mouse(0x0800, ${int(amount, "amount") * 120})
'ok'`);
}

export function typeText({ text, window }) {
  const s = String(text ?? "");
  if (s.length > 5000) return Promise.reject(new Error("text over 5000 characters"));
  // Unicode scan codes: layout-independent, and SendKeys' special characters ({}+^%~) are not special.
  const codes = [...s].map((c) => (c === "\n" ? -13 : c.codePointAt(0))).filter((c) => c < 0x10000);
  return runPs(`${origin(window)}
foreach ($c in @(${codes.join(",") || "0"})) { if ($c -eq -13) { [RosDesk]::Key(0x0D, $false); [RosDesk]::Key(0x0D, $true) } elseif ($c -gt 0) { [RosDesk]::Char([char]$c) }; Start-Sleep -Milliseconds 4 }
'ok'`);
}

// Virtual-key codes for the names a model is likely to write.
const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, cmd: 0x5b, meta: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, printscreen: 0x2c, plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe, slash: 0xbf,
};
for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x6f + i;

export function keyCodes(combo) {
  const parts = String(combo ?? "").toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("keys is empty");
  return parts.map((p) => {
    if (VK[p] !== undefined) return VK[p];
    if (/^[a-z0-9]$/.test(p)) return p.toUpperCase().charCodeAt(0);
    throw new Error(`unknown key "${p}" (use names like ctrl, shift, alt, enter, f5, a, 1)`);
  });
}

export function pressKeys({ keys, window, repeat = 1 }) {
  const codes = keyCodes(keys);
  const n = Math.max(1, Math.min(50, int(repeat, "repeat")));
  const down = codes.map((c) => `[RosDesk]::Key(${c}, $false)`).join("; ");
  const up = [...codes].reverse().map((c) => `[RosDesk]::Key(${c}, $true)`).join("; ");
  return runPs(`${origin(window)}
for ($i = 0; $i -lt ${n}; $i++) { ${down}; Start-Sleep -Milliseconds 30; ${up}; Start-Sleep -Milliseconds 40 }
'ok'`);
}
