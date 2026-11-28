#!/usr/bin/env python3
"""Pre-generate Czech question audio for male and female candidate forms.

Examiner voice is always female. Folders differ only by grammar addressed
to the candidate:
  male/   → rád, dělal, nemocný, …
  female/ → ráda, dělala, nemocná, …

Engines:
  elevenlabs  — Sarah + eleven_v3 (preferred quality)
  edge        — Microsoft cs-CZ-VlastaNeural
  piper       — local Kasandra

ElevenLabs needs ELEVENLABS_API_KEY (or --api-key). Do not commit the key.
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
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUESTIONS = ROOT / "assets/data/questions.json"
OUT_DIR = ROOT / "assets/audio/questions"
PIPER_BIN = ROOT / "tools/piper/piper/piper"
ESPEAK_DATA = ROOT / "tools/piper/piper/espeak-ng-data"
VOICE_PIPER = ROOT / "tools/piper/voices/cs_CZ-kasandra-medium.onnx"
MANIFEST = OUT_DIR / "manifest.json"

DEFAULT_ENGINE = os.environ.get("TTS_ENGINE", "elevenlabs")
DEFAULT_EDGE_RATE = os.environ.get("EDGE_RATE", "-8%")
DEFAULT_EDGE_VOICE = os.environ.get("EDGE_VOICE", "cs-CZ-VlastaNeural")
DEFAULT_ELEVEN_VOICE = os.environ.get(
    "ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL"
)  # Sarah
DEFAULT_ELEVEN_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_v3")
DEFAULT_ELEVEN_VOICE_NAME = os.environ.get("ELEVENLABS_VOICE_NAME", "Sarah")

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
    t = t.replace("ý/á", "ý" if gender == "male" else "á")
    t = re.sub(r"/a\b", "" if gender == "male" else "a", t)
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


def synthesize_elevenlabs(
    spoken: str,
    mp3_path: Path,
    *,
    api_key: str,
    voice_id: str,
    model_id: str,
    retries: int = 4,
) -> None:
    body = json.dumps(
        {
            "text": spoken,
            "model_id": model_id,
            "voice_settings": {
                "stability": 0.45,
                "similarity_boost": 0.75,
            },
        }
    ).encode("utf-8")
    url = (
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
        f"?output_format=mp3_44100_128"
    )
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "xi-api-key": api_key,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = resp.read()
            if len(data) < 500:
                raise RuntimeError(f"ElevenLabs returned tiny audio ({len(data)} bytes)")
            mp3_path.write_bytes(data)
            return
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:400]
            last_err = RuntimeError(f"HTTP {exc.code}: {detail}")
            if exc.code in {429, 500, 502, 503, 504} and attempt < retries:
                time.sleep(2 * attempt)
                continue
            raise last_err from exc
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < retries:
                time.sleep(2 * attempt)
                continue
            raise
    raise RuntimeError(str(last_err or "ElevenLabs failed"))


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
    parser.add_argument(
        "--engine",
        choices=("elevenlabs", "edge", "piper"),
        default=DEFAULT_ENGINE,
    )
    parser.add_argument(
        "--gender",
        choices=("male", "female", "both"),
        default="both",
        help="Which gendered clips to generate (default: both)",
    )
    parser.add_argument("--voice", default=DEFAULT_EDGE_VOICE, help="Edge TTS voice")
    parser.add_argument("--rate", default=DEFAULT_EDGE_RATE)
    parser.add_argument(
        "--eleven-voice",
        default=DEFAULT_ELEVEN_VOICE,
        help="ElevenLabs voice id (default: Sarah)",
    )
    parser.add_argument(
        "--eleven-model",
        default=DEFAULT_ELEVEN_MODEL,
        help="ElevenLabs model id (default: eleven_v3)",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("ELEVENLABS_API_KEY", ""),
        help="ElevenLabs API key (or set ELEVENLABS_API_KEY)",
    )
    parser.add_argument("--force", action="store_true", help="Regenerate even if file exists")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print gender resolutions / credit estimate; do not synthesize",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Only process first N bank questions (0 = all)",
    )
    args = parser.parse_args()

    genders = ["male", "female"] if args.gender == "both" else [args.gender]

    if args.engine == "piper" and not PIPER_BIN.is_file():
        print("Missing Piper binary", file=sys.stderr)
        return 1
    if args.engine == "piper" and not VOICE_PIPER.is_file():
        print("Missing Kasandra voice model", file=sys.stderr)
        return 1
    if args.engine == "elevenlabs" and not args.api_key and not args.dry_run:
        print(
            "Missing ElevenLabs API key. Set ELEVENLABS_API_KEY or pass --api-key.",
            file=sys.stderr,
        )
        return 1

    texts = unique_questions()
    if args.limit and args.limit > 0:
        texts = texts[: args.limit]

    if args.dry_run:
        spoken_set: set[str] = set()
        for text in texts:
            for g in genders:
                spoken_set.add(speakable(text, g))
            if "/" in text:
                print(f"SRC  {text}")
                for g in genders:
                    print(f"  {g:6} {speakable(text, g)}")
        print(
            f"Estimate: {len(texts)} bank texts × genders={genders} "
            f"→ {len(spoken_set)} unique spoken strings, "
            f"{sum(len(s) for s in spoken_set)} characters"
        )
        return 0

    for g in genders:
        (OUT_DIR / g).mkdir(parents=True, exist_ok=True)

    voice_label = (
        f"elevenlabs:{DEFAULT_ELEVEN_VOICE_NAME}:{args.eleven_model}"
        if args.engine == "elevenlabs"
        else f"{args.engine}:{args.voice if args.engine == 'edge' else 'kasandra'}"
    )
    print(
        f"Generating {len(texts)} bank texts × {len(genders)} folders "
        f"with {voice_label}…"
    )

    # Deduplicate TTS calls by exact spoken string within this run.
    spoken_cache: dict[str, bytes] = {}

    manifest: dict[str, dict] = {}
    if MANIFEST.is_file() and not args.force:
        try:
            manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            manifest = {}

    ok = 0
    skipped = 0
    copied = 0
    failed: list[str] = []
    total = len(texts) * len(genders)
    done = 0

    for text in texts:
        aid = audio_id(text)
        entry: dict = {
            "text": text,
            "forms": {g: speakable(text, g) for g in ("male", "female")},
            "files": {},
            "engine": voice_label,
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
                # Prefill from identical other-gender form uses :dedup; true resume uses cached.
                other = "female" if gender == "male" else "male"
                prefilled = speakable(text, other) == spoken and spoken in spoken_cache
                entry["files"][gender] = {
                    "file": f"{gender}/{mp3_path.name}",
                    "spoken": spoken,
                    "engine": f"{voice_label}:dedup" if prefilled else "cached",
                }
                continue
            try:
                if spoken in spoken_cache:
                    mp3_path.write_bytes(spoken_cache[spoken])
                    engine_used = f"{voice_label}:dedup"
                    copied += 1
                elif args.engine == "elevenlabs":
                    synthesize_elevenlabs(
                        spoken,
                        mp3_path,
                        api_key=args.api_key,
                        voice_id=args.eleven_voice,
                        model_id=args.eleven_model,
                    )
                    spoken_cache[spoken] = mp3_path.read_bytes()
                    engine_used = voice_label
                    ok += 1
                    time.sleep(0.15)  # gentle on free tier
                elif args.engine == "edge":
                    asyncio.run(
                        synthesize_edge(
                            text, mp3_path, args.voice, args.rate, gender
                        )
                    )
                    spoken_cache[spoken] = mp3_path.read_bytes()
                    engine_used = f"edge:{args.voice}"
                    ok += 1
                else:
                    with tempfile.TemporaryDirectory() as tmp:
                        wav_path = Path(tmp) / "out.wav"
                        synthesize_piper(text, wav_path, gender)
                        wav_to_mp3(wav_path, mp3_path)
                    spoken_cache[spoken] = mp3_path.read_bytes()
                    engine_used = "piper:kasandra-medium"
                    ok += 1

                # If the other gender form is identical and missing, fill it now.
                other = "female" if gender == "male" else "male"
                if (
                    args.gender == "both"
                    and speakable(text, other) == spoken
                ):
                    other_path = OUT_DIR / other / f"{aid}.mp3"
                    if args.force or not other_path.is_file() or other_path.stat().st_size < 500:
                        other_path.write_bytes(spoken_cache[spoken])
                        copied += 1

                entry["files"][gender] = {
                    "file": f"{gender}/{mp3_path.name}",
                    "spoken": spoken,
                    "engine": engine_used,
                }
                if done % 25 == 0 or done == total:
                    print(
                        f"  {done}/{total} "
                        f"(api={ok}, dedup/copy={copied}, cached={skipped}, fail={len(failed)})"
                    )
            except Exception as exc:  # noqa: BLE001
                failed.append(f"{gender}:{text}: {exc}")
                print(f"FAIL [{done}] {gender}: {text}", file=sys.stderr)
                print(f"  {exc}", file=sys.stderr)
                # Stop early on quota / auth errors
                msg = str(exc).lower()
                if "quota" in msg or "payment" in msg or "401" in msg or "unauthorized" in msg:
                    print("Stopping early due to auth/quota error.", file=sys.stderr)
                    MANIFEST.write_text(
                        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8",
                    )
                    return 1
        manifest[aid] = entry

    MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"Done. api={ok} dedup/copy={copied} skipped={skipped} "
        f"failed={len(failed)} -> {OUT_DIR}"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
