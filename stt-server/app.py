#!/usr/bin/env python3
"""Czech speaking-practice STT + light A2 grading (faster-whisper on CPU)."""

from __future__ import annotations

import os
import re
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from faster_whisper import WhisperModel
from pydantic import BaseModel, Field

API_KEY = os.environ.get("STT_API_KEY", "").strip()
MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
CPU_THREADS = int(os.environ.get("WHISPER_THREADS", "3"))

model: WhisperModel | None = None


def require_key(x_api_key: str | None = Header(default=None)) -> None:
    if not API_KEY:
        return
    if not x_api_key or x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global model
    model = WhisperModel(
        MODEL_NAME,
        device=DEVICE,
        compute_type=COMPUTE,
        cpu_threads=CPU_THREADS,
    )
    yield
    model = None


app = FastAPI(title="Czech speaking STT", lifespan=lifespan)


class GradeOut(BaseModel):
    heard: str
    ok: bool
    score: int = Field(ge=0, le=5)
    note: str
    better: str | None = None
    source: str = "whisper-local"


YES_NO_RE = re.compile(
    r"^(jste|máte|máš|je |jsou |bydlíte|chodíte|mluvíte|umíte|znáte|"
    r"pracujete|studujete|vaříte|sportujete|cestujete|chcete|můžete)",
    re.I,
)


def grade_a2(question: str, heard: str) -> dict:
    text = (heard or "").strip()
    q = (question or "").strip()
    if not text:
        return {
            "ok": False,
            "score": 1,
            "note": "Nerozumím — zkuste mluvit hlasitěji a celou větou.",
            "better": None,
        }

    words = re.findall(r"[\wÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]+", text, flags=re.UNICODE)
    n = len(words)
    lower = text.lower()

    # Single-word yes/no
    if n <= 2 and YES_NO_RE.search(q):
        if any(w in lower for w in ("ano", "ne", "jo", "někdy", "občas")):
            return {
                "ok": True,
                "score": 3,
                "note": "Srozumitelné, ale zkuste celou větu (např. Ano, jsem ženatý.).",
                "better": None,
            }

    if n <= 2:
        return {
            "ok": False,
            "score": 2,
            "note": "Příliš krátké — odpovězte jednou celou větou.",
            "better": None,
        }

    # Looks like a full sentence
    has_verbish = bool(
        re.search(
            r"\b(jsem|jste|jsme|jsou|mám|máte|bydlím|bydlíme|pracuji|studuji|"
            r"chodím|mluvím|umím|vařím|jezdím|cestuji|chtěl|chtěla|můžu)\b",
            lower,
        )
    )
    if n >= 4 and has_verbish:
        return {
            "ok": True,
            "score": 5,
            "note": "Dobrá celá věta.",
            "better": None,
        }
    if n >= 3 and has_verbish:
        return {
            "ok": True,
            "score": 4,
            "note": "Srozumitelné — dobrá krátká věta.",
            "better": None,
        }
    if n >= 4:
        return {
            "ok": True,
            "score": 4,
            "note": "Srozumitelné — příště dbejte na úplnou větu.",
            "better": None,
        }
    return {
        "ok": True,
        "score": 3,
        "note": "Částečně srozumitelné — přidejte podmět a sloveso.",
        "better": None,
    }


def transcribe_file(path: Path) -> str:
    assert model is not None
    segments, _info = model.transcribe(
        str(path),
        language="cs",
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    parts = [seg.text.strip() for seg in segments if seg.text and seg.text.strip()]
    return " ".join(parts).strip()


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute": COMPUTE,
        "ready": model is not None,
    }


@app.post("/v1/answer", response_model=GradeOut, dependencies=[Depends(require_key)])
async def answer(
    question: str = Form(...),
    audio: UploadFile = File(...),
) -> GradeOut:
    suffix = Path(audio.filename or "clip.webm").suffix or ".webm"
    raw = await audio.read()
    if len(raw) < 200:
        raise HTTPException(status_code=400, detail="Audio too short")

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
        tmp_path = Path(tmp.name)

    try:
        heard = transcribe_file(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)

    graded = grade_a2(question, heard)
    return GradeOut(heard=heard, **graded)
