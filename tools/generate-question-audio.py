#!/usr/bin/env python3
"""Pre-generate Czech question audio with Piper (offline TTS)."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUESTIONS = ROOT / "assets/data/questions.json"
OUT_DIR = ROOT / "assets/audio/questions"
PIPER_BIN = ROOT / "tools/piper/piper/piper"
ESPEAK_DATA = ROOT / "tools/piper/piper/espeak-ng-data"
VOICE = ROOT / "tools/piper/voices/cs_CZ-jirka-low.onnx"
MANIFEST = OUT_DIR / "manifest.json"


def speakable(text: str) -> str:
    """Light cleanup so Piper reads slash alternatives naturally."""
    t = text.strip()
    t = t.replace("/", " nebo ")
    while "  " in t:
        t = t.replace("  ", " ")
    return t


def audio_id(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:40]


def unique_questions() -> list[str]:
    data = json.loads(QUESTIONS.read_text(encoding="utf-8"))
    seen: set[str] = set()
    out: list[str] = []
    for topic in data["topics"].values():
        for q in topic["questions"]:
            text = str(q["question"]).strip()
            if text and text not in seen:
                seen.add(text)
                out.append(text)
    return out


def synthesize(text: str, wav_path: Path) -> None:
    cmd = [
        str(PIPER_BIN),
        "--espeak_data",
        str(ESPEAK_DATA),
        "-m",
        str(VOICE),
        "-f",
        str(wav_path),
        "--length_scale",
        "0.95",
        "--sentence_silence",
        "0.25",
        "-q",
    ]
    proc = subprocess.run(
        cmd,
        input=speakable(text) + "\n",
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0 or not wav_path.is_file() or wav_path.stat().st_size < 44:
        raise RuntimeError(
            f"Piper failed for {text!r}: rc={proc.returncode} stderr={proc.stderr[-500:]}"
        )


def wav_to_mp3(wav_path: Path, mp3_path: Path) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(wav_path),
        "-codec:a",
        "libmp3lame",
        "-qscale:a",
        "5",
        "-ac",
        "1",
        str(mp3_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0 or not mp3_path.is_file():
        raise RuntimeError(f"ffmpeg failed: {proc.stderr[-500:]!r}")


def main() -> int:
    if not PIPER_BIN.is_file():
        print("Missing Piper binary", file=sys.stderr)
        return 1
    if not VOICE.is_file():
        print("Missing Czech voice model", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    texts = unique_questions()
    print(f"Generating {len(texts)} unique question clips…")

    manifest: dict[str, dict] = {}
    ok = 0
    skipped = 0
    failed: list[str] = []

    for i, text in enumerate(texts, 1):
        aid = audio_id(text)
        mp3_path = OUT_DIR / f"{aid}.mp3"
        if mp3_path.is_file() and mp3_path.stat().st_size > 500:
            skipped += 1
            manifest[aid] = {"text": text, "file": mp3_path.name}
            continue
        try:
            with tempfile.TemporaryDirectory() as tmp:
                wav_path = Path(tmp) / "out.wav"
                synthesize(text, wav_path)
                wav_to_mp3(wav_path, mp3_path)
            manifest[aid] = {"text": text, "file": mp3_path.name}
            ok += 1
            if i % 25 == 0 or i == len(texts):
                print(f"  {i}/{len(texts)} done (new={ok}, cached={skipped})")
        except Exception as exc:  # noqa: BLE001
            failed.append(f"{text}: {exc}")
            print(f"FAIL [{i}]: {text}", file=sys.stderr)
            print(f"  {exc}", file=sys.stderr)

    MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Done. new={ok} skipped={skipped} failed={len(failed)} -> {OUT_DIR}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
