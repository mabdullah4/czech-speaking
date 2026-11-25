#!/usr/bin/env python3
"""Pre-generate Czech question audio for male and female candidate forms.

Examiner voice is always female (Edge TTS cs-CZ-VlastaNeural).
Folders differ only by grammar addressed to the candidate:
  male/   → rád, dělal, nemocný, …
  female/ → ráda, dělala, nemocná, …
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUESTIONS = ROOT / "assets/data/questions.json"
OUT_DIR = ROOT / "assets/audio/questions"
PIPER_BIN = ROOT / "tools/piper/piper/piper"
ESPEAK_DATA = ROOT / "tools/piper/piper/espeak-ng-data"
VOICE_PIPER = ROOT / "tools/piper/voices/cs_CZ-kasandra-medium.onnx"
MANIFEST = OUT_DIR / "manifest.json"

DEFAULT_ENGINE = os.environ.get("TTS_ENGINE", "edge")
DEFAULT_EDGE_RATE = os.environ.get("EDGE_RATE", "-8%")
# Examiner is always a woman; folders only change candidate grammar forms.
DEFAULT_EDGE_VOICE = os.environ.get("EDGE_VOICE", "cs-CZ-VlastaNeural")

# Word pairs where the slash order is female/male (not stem+/a).
SPECIAL_PAIRS = {
    "vdaná/ženatý": {"male": "ženatý", "female": "vdaná"},
}


def resolve_gender(text: str, gender: str) -> str:
    """Turn exam slash forms into a single speakable gender variant."""
    if gender not in ("male", "female"):
        raise ValueError(f"gender must be male|female, got {gender!r}")
    t = text.strip()
    for pair, forms in SPECIAL_PAIRS.items():
        t = t.replace(pair, forms[gender])
    # nemocný/á → nemocný | nemocná
    t = t.replace("ý/á", "ý" if gender == "male" else "á")
    # dělal/a, rád/a, nerad/a → dělal|dělala, rád|ráda, …
    t = re.sub(r"/a\b", "" if gender == "male" else "a", t)
    # Remaining alternatives (bytu/domu, bytě/domě) → "nebo"
    t = t.replace("/", " nebo ")
    while "  " in t:
        t = t.replace("  ", " ")
    return t


def speakable(text: str, gender: str) -> str:
    return resolve_gender(text, gender)


def audio_id(text: str) -> str:
    """Stable id from the bank text (with slash forms), shared across genders."""
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


def synthesize_piper(text: str, wav_path: Path, gender: str) -> None:
    cmd = [
        str(PIPER_BIN),
        "--espeak_data",
        str(ESPEAK_DATA),
        "-m",
        str(VOICE_PIPER),
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
        input=speakable(text, gender) + "\n",
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0 or not wav_path.is_file() or wav_path.stat().st_size < 44:
        raise RuntimeError(
            f"Piper failed for {text!r}: rc={proc.returncode} stderr={proc.stderr[-500:]}"
        )


async def synthesize_edge(
    text: str, mp3_path: Path, voice: str, rate: str, gender: str
) -> None:
    import edge_tts

    communicate = edge_tts.Communicate(speakable(text, gender), voice, rate=rate)
    await communicate.save(str(mp3_path))
    if not mp3_path.is_file() or mp3_path.stat().st_size < 500:
        raise RuntimeError(f"edge-tts produced empty file for {text!r}")


def wav_to_mp3(wav_path: Path, mp3_path: Path) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(wav_path),
        "-codec:a",
        "libmp3lame",
        "-qscale:a",
        "4",
        "-ac",
        "1",
        str(mp3_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0 or not mp3_path.is_file():
        raise RuntimeError(f"ffmpeg failed: {proc.stderr[-500:]!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=("edge", "piper"), default=DEFAULT_ENGINE)
    parser.add_argument(
        "--gender",
        choices=("male", "female", "both"),
        default="both",
        help="Which gendered clips to generate (default: both)",
    )
    parser.add_argument("--voice", default=DEFAULT_EDGE_VOICE, help="Edge TTS voice (default: Vlasta)")
    parser.add_argument("--rate", default=DEFAULT_EDGE_RATE)
    parser.add_argument("--force", action="store_true", help="Regenerate even if file exists")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print gender resolutions only; do not synthesize",
    )
    args = parser.parse_args()

    genders = ["male", "female"] if args.gender == "both" else [args.gender]

    if args.engine == "piper" and not PIPER_BIN.is_file():
        print("Missing Piper binary", file=sys.stderr)
        return 1
    if args.engine == "piper" and not VOICE_PIPER.is_file():
        print("Missing Kasandra voice model", file=sys.stderr)
        return 1

    texts = unique_questions()
    if args.dry_run:
        for text in texts:
            if "/" not in text:
                continue
            print(f"SRC  {text}")
            for g in genders:
                print(f"  {g:6} {speakable(text, g)}")
        return 0

    for g in genders:
        (OUT_DIR / g).mkdir(parents=True, exist_ok=True)

    print(
        f"Generating {len(texts)} × {len(genders)} clips "
        f"with engine={args.engine} voice={args.voice} forms={','.join(genders)}…"
    )

    manifest: dict[str, dict] = {}
    ok = 0
    skipped = 0
    failed: list[str] = []
    total = len(texts) * len(genders)
    done = 0

    for text in texts:
        aid = audio_id(text)
        entry: dict = {
            "text": text,
            "forms": {g: speakable(text, g) for g in ("male", "female")},
            "files": {},
        }
        for gender in genders:
            done += 1
            mp3_path = OUT_DIR / gender / f"{aid}.mp3"
            spoken = speakable(text, gender)
            if (
                not args.force
                and mp3_path.is_file()
                and mp3_path.stat().st_size > 500
            ):
                skipped += 1
                entry["files"][gender] = {
                    "file": f"{gender}/{mp3_path.name}",
                    "spoken": spoken,
                    "engine": "cached",
                }
                continue
            try:
                if args.engine == "edge":
                    asyncio.run(
                        synthesize_edge(
                            text, mp3_path, args.voice, args.rate, gender
                        )
                    )
                    engine_used = f"edge:{args.voice}"
                else:
                    with tempfile.TemporaryDirectory() as tmp:
                        wav_path = Path(tmp) / "out.wav"
                        synthesize_piper(text, wav_path, gender)
                        wav_to_mp3(wav_path, mp3_path)
                    engine_used = "piper:kasandra-medium"
                entry["files"][gender] = {
                    "file": f"{gender}/{mp3_path.name}",
                    "spoken": spoken,
                    "engine": engine_used,
                }
                ok += 1
                if done % 25 == 0 or done == total:
                    print(f"  {done}/{total} done (new={ok}, cached={skipped})")
            except Exception as exc:  # noqa: BLE001
                failed.append(f"{gender}:{text}: {exc}")
                print(f"FAIL [{done}] {gender}: {text}", file=sys.stderr)
                print(f"  {exc}", file=sys.stderr)
        manifest[aid] = entry

    MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Done. new={ok} skipped={skipped} failed={len(failed)} -> {OUT_DIR}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
