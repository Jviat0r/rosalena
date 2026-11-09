# Rosalena Harness 0.1.0

Early preview. A desktop app for local and free AI models: your own machine's model through
the bundled router, or a free cloud model, with plugins, subagents and MCP in one window.

These files were rebuilt on 2026-10-20, replacing the first 0.1.0 build from earlier the same
day. The first build opened fine on a Mac and then refused every message with a router error
(HTTP 503, "every target in the chain failed", reason `no_key`). The cause was in the app, not
in the Mac: the router treated the free model as needing an API key, no key is stored on a
fresh install, and the class had one target, so a skipped target left nothing to answer. The
free model does not use a key at all, and the router now knows that. If you downloaded before
this rebuild, download again.

**Both builds are unsigned.** There is no code-signing certificate for this project yet, so
Windows and macOS both ask you to step past a warning on the first launch. What to do is
written under each file below.

## Windows, 64-bit

| File | Size | What it is |
|---|---|---|
| `Rosalena-Harness-Setup-0.1.0-x64.exe` | 106.0 MB (111,109,267 bytes) | Installer (NSIS). Installs per user, adds a Start menu entry, uninstalls from Apps and features. |
| `Rosalena-Harness-0.1.0-x64-portable.exe` | 105.8 MB (110,896,338 bytes) | Portable single file. Run it from anywhere, no install, no leftovers. |

First launch: SmartScreen shows "Windows protected your PC" because the file is unsigned.
Choose **More info**, then **Run anyway**. The portable file behaves the same way.

## macOS

| File | Size | What it is |
|---|---|---|
| `Rosalena-Harness-0.1.0-arm64.dmg` | 122.4 MB (128,385,793 bytes) | Disk image for Apple silicon. Drag the app to Applications. |
| `Rosalena-Harness-0.1.0-arm64.zip` | 122.6 MB (128,559,765 bytes) | The same app as a zip, for Apple silicon. |
| `Rosalena-Harness-0.1.0-x64.dmg` | 126.0 MB (132,156,866 bytes) | Disk image for Intel Macs. |
| `Rosalena-Harness-0.1.0-x64.zip` | 126.2 MB (132,363,646 bytes) | The same app as a zip, for Intel Macs. |

Unsigned and not notarized, so macOS quarantines the download and refuses the first launch.
Either right-click the app in Applications, choose **Open**, then **Open** again, or clear
the quarantine bit once:

```bash
xattr -dr com.apple.quarantine "/Applications/Rosalena Harness.app"
```

The window itself has now been opened on a Mac once, and that run is the reason these files
were rebuilt: it launched, drew its window and reached the router, and then failed every
message for the reason above. Everything the fix changed is covered by tests and was checked
end to end against the real model with no key configured, but the chat window on macOS has
been exercised once, not many times.

## Checksums

```text
f6122c97380ea91c5f069d2498fa27bb29feebff2d4d076b1be70bb9ec138428  Rosalena-Harness-Setup-0.1.0-x64.exe
bf734a62e0ea6a7aa34df332adb389f8d999c310ba8bf9be28352cee3abdf1c2  Rosalena-Harness-0.1.0-x64-portable.exe
886c8fbb452253d4112ea0918f0ae64b0cf4c279026617c5e35479ed8a7e66e2  Rosalena-Harness-0.1.0-arm64.dmg
37c6cd33000860348d5538db59d75cd42f480b294ff8b560bd8569c828deae1f  Rosalena-Harness-0.1.0-arm64.zip
5c87623b6e8342fc56abe0b28fbb4f94855606850dd906319736c74f981f4e3b  Rosalena-Harness-0.1.0-x64.dmg
17e19d8ed2ec85e0abb325c6e76f41f6524a5d437561c1ce8b9bea1a1d606925  Rosalena-Harness-0.1.0-x64.zip
```

Check a download before you run it:

```bash
sha256sum -c <(grep . <<'EOF'
f6122c97380ea91c5f069d2498fa27bb29feebff2d4d076b1be70bb9ec138428  Rosalena-Harness-Setup-0.1.0-x64.exe
EOF
)
```

`shasum -a 256 <file>` on macOS, `certutil -hashfile <file> SHA256` on Windows.

## What is in the box

- The window: chat, the model picker, files, plugins, subagents, MCP servers, jobs.
- The router, which starts with the app and serves an OpenAI-compatible API on port 8077.
- No account, no telemetry, no bundled model. Your chats, files and keys stay on your
  machine, and free cloud models work on any 64-bit machine, with no key of any kind.

## Known limits

- Unsigned on both platforms, as described above.
- Voice input stays a separate, optional download: it needs a Python runtime.
- The free cloud tier is shared per network address. If it is busy or has seen too much
  traffic from your address, it answers 429 and so does the second free model behind it;
  the app then reports that it could not reach a model rather than pretending otherwise.
- The public trial on the website is not part of this app and needs no download.

Every size and checksum above is also published on the download page:
<https://rosalena.pages.dev/download/>
