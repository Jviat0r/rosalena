// The Win32 side of desktop control, as one PowerShell prelude. It is compiled once per
// call by Add-Type; the actions use SendInput (the supported input path) and the process
// declares itself DPI-aware so every coordinate is a physical pixel.

export const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not ('RosDesk' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RosDesk {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy, data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public int flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public int type; public UNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  public static void Mouse(int flags, int data) { var i = new INPUT { type = 0 }; i.u.mi.flags = flags; i.u.mi.data = data; Send(i); }
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  // Arrows, Home/End, Insert/Delete and the right-hand modifiers are "extended" keys.
  static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C; }
  public static void Key(ushort vk, bool up) {
    var i = new INPUT { type = 1 };
    i.u.ki.vk = vk;
    i.u.ki.scan = (ushort)MapVirtualKey(vk, 0);
    i.u.ki.flags = (up ? 2 : 0) | (Extended(vk) ? 1 : 0);
    Send(i);
  }
  public static void Char(char c) {
    var d = new INPUT { type = 1 }; d.u.ki.scan = c; d.u.ki.flags = 4; Send(d);
    var u = new INPUT { type = 1 }; u.u.ki.scan = c; u.u.ki.flags = 4 | 2; Send(u);
  }
}
'@
}
[void][RosDesk]::SetProcessDPIAware()
function Find-Win([string]$title) {
  $found = New-Object System.Collections.ArrayList
  [void][RosDesk]::EnumWindows({ param($h, $l)
    if ([RosDesk]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][RosDesk]::GetWindowText($h, $sb, 512)
      $t = $sb.ToString()
      if ($t -and ($title -eq '' -or $t.ToLower().Contains($title.ToLower()))) {
        $wpid = 0; [void][RosDesk]::GetWindowThreadProcessId($h, [ref]$wpid)
        $pn = ''; try { $pn = (Get-Process -Id $wpid).ProcessName } catch {}
        [void]$found.Add([pscustomobject]@{ h = $h; title = $t; process = $pn })
      }
    }
    return $true }, [IntPtr]::Zero)
  return $found
}
function Win-Rect($h) { $r = New-Object RosDesk+RECT; [void][RosDesk]::GetWindowRect($h, [ref]$r); return $r }
function Focus-Win($h) {
  if ([RosDesk]::IsIconic($h)) { [void][RosDesk]::ShowWindow($h, 9) }
  if ([RosDesk]::GetForegroundWindow() -eq $h) { return }
  # Windows refuses focus to a background process unless a key event just happened. F24 is
  # used because no app binds it; an Alt tap would put the window in menu mode and the
  # next keystroke would be eaten as a menu mnemonic.
  [RosDesk]::Key(0x87, $false); [RosDesk]::Key(0x87, $true)
  [void][RosDesk]::SetForegroundWindow($h)
  # Wait until it really is in front: the first keystroke is lost to a window still activating.
  for ($i = 0; $i -lt 20 -and [RosDesk]::GetForegroundWindow() -ne $h; $i++) { Start-Sleep -Milliseconds 25 }
  Start-Sleep -Milliseconds 150
}
`;
