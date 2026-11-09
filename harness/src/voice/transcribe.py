#!/usr/bin/env python
"""Transcribe a WAV file locally with faster-whisper.

This is the accurate backend for the harness "/voice" command. It runs on the
CPU on purpose: the one GPU on this box belongs to the writer model, and an
utterance of a few seconds does not need it.

Deliberately not a package: it takes a WAV path and writes text, so the harness
can call it as a plain child process and nothing else in the project has to know
about Python.

    uv run --python 3.12 --with faster-whisper -- python transcribe.py --wav a.wav
    python transcribe.py --warm            load and cache the model, then exit

Audio is decoded here rather than by faster-whisper. Its own decoder goes through
PyAV, and faster-whisper 1.2.1 with PyAV 19 dies with "open() got an unexpected
keyword argument 'metadata_errors'" - a version fight that would otherwise be
pinned away. The standard library reads a PCM WAV fine, ffmpeg resamples the rare
file that is not already 16 kHz mono, and the model gets the float32 array it
wants. Fewer moving parts, and no version constraints to maintain.

Exit codes: 0 ok, 3 faster-whisper missing, 4 transcription failed.
"""

import argparse
import io
import json
import math
import os
import subprocess
import sys
import time
import wave

TARGET_RATE = 16000


def read_pcm16(source):
    """Read 16-bit PCM WAV into float32 samples in [-1, 1]; path or binary stream."""
    import numpy as np

    with wave.open(source, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())

    if width != 2:
        raise ValueError(f"expected 16-bit PCM audio, got {width * 8}-bit")
    if channels < 1:
        raise ValueError("audio file reports no channels")

    audio = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, rate


def as_16k_mono(path, ffmpeg="ffmpeg"):
    """Return mono float32 audio at 16 kHz, resampling with ffmpeg if needed."""
    audio, rate = read_pcm16(path)
    if rate == TARGET_RATE:
        return audio

    # Pipe the resampled WAV through stdout instead of writing a temporary file:
    # tempfile honours TEMP/TMP, which a sandboxed child may not be able to write
    # to, and when those are unset Python falls back to the CURRENT DIRECTORY -
    # which left a trail of resample directories behind in the repo.
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", path,
             "-ac", "1", "-ar", str(TARGET_RATE), "-f", "wav", "-"],
            capture_output=True,
        )
    except OSError as err:
        raise ValueError(f"input is {rate} Hz and ffmpeg is unavailable to resample it: {err}") from err
    if proc.returncode != 0 or not proc.stdout:
        lines = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        detail = lines[-1] if lines else "no output"
        raise ValueError(f"ffmpeg could not resample the {rate} Hz input: {detail}")
    resampled, _ = read_pcm16(io.BytesIO(proc.stdout))
    return resampled


def measure(audio):
    """Peak and RMS level in dBFS.

    The quickest way to tell a dead input from a quiet one: a microphone that
    is not plugged in, muted, or at zero gain records digital silence, while a
    live one always has a noise floor around -50 dB.
    """
    import numpy as np

    if audio.size == 0:
        return {"seconds": 0.0, "peakDb": None, "rmsDb": None}
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(np.square(audio))))
    return {
        "seconds": round(audio.size / TARGET_RATE, 2),
        "peakDb": round(20 * math.log10(peak), 1) if peak > 0 else None,
        "rmsDb": round(20 * math.log10(rms), 1) if rms > 0 else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Local speech-to-text (faster-whisper)")
    parser.add_argument("--wav", help="16 kHz mono WAV to transcribe")
    parser.add_argument("--out", help="write the transcript here (UTF-8); default stdout")
    parser.add_argument("--model", default="base.en", help="faster-whisper model name")
    parser.add_argument("--language", default="en")
    parser.add_argument(
        "--vad-threshold",
        type=float,
        default=0.2,
        help="Silero VAD speech probability threshold; lower is more sensitive "
        "and is what a quiet microphone needs",
    )
    parser.add_argument("--warm", action="store_true", help="load the model and exit")
    args = parser.parse_args()

    if not args.wav and not args.warm:
        parser.error("--wav is required unless --warm is given")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.stderr.write(
            "faster-whisper is not installed in this interpreter. "
            "Run setup.ps1 next to this file.\n"
        )
        return 3

    started = time.time()
    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
    except Exception as err:  # model download failure, bad name, no disk
        sys.stderr.write(f"could not load model {args.model!r}: {err}\n")
        return 4

    loaded_ms = int((time.time() - started) * 1000)

    if args.warm:
        sys.stderr.write(
            json.dumps({"ok": True, "warmed": args.model, "loadMs": loaded_ms}) + "\n"
        )
        return 0

    try:
        audio = as_16k_mono(args.wav)
    except (ValueError, OSError, EOFError) as err:
        sys.stderr.write(f"could not read {args.wav}: {err}\n")
        return 4

    levels = measure(audio)

    try:
        # Voice activity detection first, and this matters: without it the model
        # is always asked for its best guess, so a recording of nothing but room
        # tone comes back as confident nonsense ("Earring Earring Earring...",
        # "Thank you."). With it, a silent recording yields an empty transcript
        # and the harness can honestly say it heard nothing.
        segments, info = model.transcribe(
            audio,
            language=args.language,
            beam_size=1,
            vad_filter=True,
            vad_parameters={"threshold": args.vad_threshold},
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
    except Exception as err:
        sys.stderr.write(f"transcription failed: {err}\n")
        return 4

    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text + "\n")

    sys.stderr.write(
        json.dumps(
            {
                "ok": True,
                "model": args.model,
                "language": info.language,
                "loadMs": loaded_ms,
                "totalMs": int((time.time() - started) * 1000),
                "chars": len(text),
                **levels,
            }
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
