# Voice input for the prompt bar

Speak a prompt instead of typing it. Whatever is heard lands **in the prompt
line**, to be read and corrected before it is sent - it is never submitted on its
own. That is the whole design: a recognizer that turns "json" into "JSO" is
useful when you can fix it, and dangerous when it can press Enter for you.

**This is Windows-only, and it says so.** Capture asks ffmpeg for a DirectShow device
(`-f dshow`) and the built-in recognizer is PowerShell's `System.Speech`; neither exists on
macOS or Linux. `detectBackends()` therefore reports every backend unavailable off Windows,
with that reason, and `pickBackend()` refuses instead of half-starting - a voice button that
opens a microphone that cannot record is worse than no voice button. The desktop app's
window has no microphone control at all, so there is nothing to disable there either.

## Quick start

```powershell
# once: install the accurate local engine (isolated venv, no admin, ~500 MB)
powershell -NoProfile -ExecutionPolicy Bypass -File src\voice\setup.ps1

node src\cli.mjs --voice      # every prompt starts by listening
node src\cli.mjs              # or type /voice when you want it
```

Nothing is required to try the fallback: the recognizer built into Windows is
always there.

## In a session

| Command | What it does |
|---|---|
| `/voice` | listen once; the transcript appears in the prompt line |
| `/voice status` | which backends are ready, and which microphones exist |
| `/voice mics` | list the microphones Windows can see |
| `/voice backend X` | use one backend for this session |
| `/voice on` / `/voice off` | listen automatically at every prompt |
| `/help` | everything the session understands |

While recording, **press Enter to finish** and transcribe immediately. If you
forget, the recording stops by itself after `--voice-seconds` (default 15).

## Flags

| Flag | Meaning |
|---|---|
| `--voice` | voice-first: listen at every prompt |
| `--stt <name>` | force a backend: `whisper`, `openai`, `windows` |
| `--mic "<name>"` | use a specific input device |
| `--voice-seconds <n>` | recording backstop (default 15) |
| `--model <name>` | faster-whisper model (default `base.en`) |
| `--voice-status` | print backend readiness and exit |

## Backends

Measured on this machine by the test suite, transcribing the same synthesized
sentence ("add a json flag to the export command"):

| Backend | Needs | Heard |
|---|---|---|
| `whisper` | `setup.ps1` (~500 MB, one time) | `Add a JSO and flag to the export command.` |
| `openai` | `OPENAI_API_KEY` | not installed |
| `windows` | nothing | `Adage as Owen flag to the export command` |

`windows` is the one that always works; `whisper` is the one worth using. The
accurate backend runs on the **CPU** on purpose - the single GPU belongs to the
writer model, and a few seconds of speech does not need it.

## How it is put together

| File | Role |
|---|---|
| `../voice.mjs` | backend detection, recording, transcription, `listen()` |
| `transcribe.py` | faster-whisper wrapper (takes a WAV, prints text) |
| `win-speech.ps1` | Windows `System.Speech` recognition, live or from a file |
| `setup.ps1` | creates the isolated environment and caches the model |
| `selftest.ps1` | speaks a known sentence and checks it comes back |

Audio is decoded by `transcribe.py` itself rather than by faster-whisper: its
own decoder goes through PyAV, and faster-whisper 1.2.1 with PyAV 19 fails with
`open() got an unexpected keyword argument 'metadata_errors'`. The standard
library reads a PCM WAV fine and ffmpeg resamples anything that is not already
16 kHz mono, so no version pins are needed.

Transcription runs with **voice activity detection on**, at a threshold well
below the 0.5 Silero ships with. Both halves of that matter:

- Without VAD the model is always asked for its best guess, so a recording of
  nothing but room tone comes back as confident nonsense ("Earring Earring
  Earring..."), which lands in the prompt line looking like something you said.
- At the default 0.5 threshold the opposite happens: quiet speech is discarded
  as non-speech and the transcript comes back **empty, with no error at all**.
  Measured against this machine's microphone (peak -16 dBFS / RMS -36), 0.5
  loses the speech entirely, 0.2 keeps it, and 0.1 lets the hallucination loop
  back in. `--vad-threshold` overrides it for a quieter microphone.

## Tests

```powershell
node --test
```

The speech-to-text half is tested for real without a microphone: the Windows
synthesizer speaks a known sentence into a WAV file and both engines have to
transcribe it. Only microphone capture needs a person in the room.

## Microphone setup

A microphone connected to an audio interface appears as ffmpeg's capture device
for that interface - on this machine `Analogue 1 + 2 (Focusrite USB Audio)`.
That *is* the microphone input. Measured live here, with a person talking into
it:

| What | Peak | RMS |
|---|---|---|
| quiet room (noise floor) | -27.9 dBFS | -43.5 dBFS |
| a person speaking | -16.0 dBFS | -35.9 dBFS |

Both channels carry the same signal (the interface mirrors one input across the
stereo pair) and `record()` captures 16 kHz mono, so nothing is lost. A live
microphone always has a noise floor around -50 dBFS: digital silence means the
input is muted or at zero gain, and the harness prints a warning when a
recording peaks far below -40 dBFS.

## Known limits

- The first capture device ffmpeg lists is used by default. On a machine with
  several, pass `--mic "<name>"` (`/voice mics` prints them).
- Recording stops on Enter or after `--voice-seconds`; there is deliberately no
  silence auto-stop, which would cut a speaker off mid-thought.
- `windows` inherits the accuracy of the installed desktop recognizer, so a
  different machine may score differently.
