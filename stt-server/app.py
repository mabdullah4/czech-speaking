#!/usr/bin/env python3
"""Czech speaking-practice STT + strict A2 grading (English notes)."""

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

WORD_RE = re.compile(
    r"[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž0-9]+",
    re.UNICODE,
)

STOP = {
    "a", "i", "o", "u", "v", "ve", "na", "do", "z", "ze", "k", "ke", "s", "se",
    "je", "to", "ta", "ten", "ty", "tě", "mi", "mě", "mne", "já", "vy", "ty",
    "my", "oni", "ono", "co", "že", "jak", "tak", "už", "jen", "si", "mi",
    "pro", "při", "po", "od", "za", "před", "mezi", "nebo", "ale", "také",
    "the", "a", "an",
}

YES_NO_START = re.compile(
    r"^(jste|jsi|máte|máš|je\b|jsou\b|bydlíte|chodíte|mluvíte|umíte|znáte|"
    r"pracujete|studujete|vaříte|sportujete|cestujete|chcete|můžete|"
    r"navštěvujete|používáte|sledujete|posloucháte|čtete|píšete)",
    re.I,
)

VERBISH = re.compile(
    r"\b("
    r"jsem|jsi|je|jsme|jste|jsou|byl|byla|bylo|byli|byly|"
    r"mám|máš|má|máme|máte|mají|"
    r"bydlím|bydlíš|bydlí|bydlíme|bydlíte|"
    r"pracuji|pracuju|pracuje|studuji|studuju|"
    r"chodím|chodí|mluvím|mluví|umím|umí|vařím|vaří|"
    r"jezdím|jezdí|cestuji|cestuju|chtěl|chtěla|chci|chce|"
    r"můžu|můžeš|může|musím|rád|ráda|líbí|"
    r"navštěvuji|používám|sleduji|poslouchám|čtu|píšu|"
    r"žiji|žiju|žijeme|pracoval|pracovala|studoval|studovala"
    r")\b",
    re.I,
)

PLACE_HINT = re.compile(
    r"\b(v|ve|na|u|bydím|bydlím|praze|praha|brně|brno|ostravě|byt[ěe]?|dom[ěe]?|"
    r"měst[ěe]?|vesnici|česku|republice|ulici|patře)\b",
    re.I,
)
TIME_HINT = re.compile(
    r"\b(dnes|zítra|včera|ráno|večer|odpoledne|týden|měsíc|rok|roky|let|"
    r"často|někdy|občas|vždy|každý|každou|hodin|minut|v\s+\d|od\s+\d|do\s+\d|"
    r"pondělí|úterý|středu|čtvrtek|pátek|sobotu|neděli)\b",
    re.I,
)
NUMBER_HINT = re.compile(r"\b(\d+|jeden|jedna|jedno|dva|dvě|tři|čtyři|pět|šest|sedm|osm|devět|deset|několik|moc|málo)\b", re.I)
PERSON_HINT = re.compile(
    r"\b(máma|mama|matka|táta|tata|otec|bratr|sestra|manžel|manželka|"
    r"přítel|přítelkyně|kamarád|kamarádka|děti|syn|dcera|rodina|kolega|učitel)\b",
    re.I,
)
REASON_HINT = re.compile(r"\b(protože|proto|kvůli|neboť|aby)\b", re.I)


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


def fold(text: str) -> str:
    text = text.lower().strip()
    # keep Czech letters; only strip combining marks that are not Czech
    return text


def tokens(text: str) -> list[str]:
    return [m.group(0).lower() for m in WORD_RE.finditer(text or "")]


def content_tokens(text: str) -> set[str]:
    return {t for t in tokens(text) if t not in STOP and len(t) > 2}


def question_type(question: str) -> str:
    q = fold(question)
    if "kolik" in q:
        return "quantity"
    if re.search(r"\bkde\b", q):
        return "place"
    if re.search(r"\bkdy\b", q) or "jak často" in q or "jak dlouho" in q:
        return "time"
    if re.search(r"\bkdo\b", q):
        return "person"
    if re.search(r"\bproč\b", q):
        return "reason"
    if re.search(r"\b(jaký|jaká|jaké|jakou|jací)\b", q) or re.search(r"\bjak\b", q):
        return "description"
    if re.search(r"\bco\b", q):
        return "what"
    if YES_NO_START.search(q):
        return "yesno"
    return "general"


def answers_question(question: str, answer: str, qtype: str) -> tuple[bool, str]:
    """Return (relevant, reason_if_not)."""
    a = fold(answer)
    q = fold(question)
    q_content = content_tokens(question)
    a_content = content_tokens(answer)
    overlap = q_content & a_content

    if qtype == "yesno":
        has_yn = bool(re.search(r"\b(ano|ne|jo|někdy|občas|vůbec)\b", a))
        # Full answer like "Jsem ženatý" / "Bydlím v Praze" without ano/ne can still work
        if has_yn and VERBISH.search(a) and len(tokens(answer)) >= 4:
            return True, ""
        if has_yn and len(tokens(answer)) <= 2:
            return False, "Yes/no alone is not enough — answer in a full sentence."
        if VERBISH.search(a) and len(tokens(answer)) >= 4:
            return True, ""
        if has_yn:
            return False, "Add a full sentence that explains your yes/no."
        return False, "This is a yes/no question — your answer does not address it."

    if qtype == "place":
        if PLACE_HINT.search(a) or overlap:
            return True, ""
        return False, "The question asks where — your answer does not give a place."

    if qtype == "time":
        if TIME_HINT.search(a) or overlap or NUMBER_HINT.search(a):
            return True, ""
        return False, "The question asks when/how often/how long — no time info in your answer."

    if qtype == "quantity":
        if NUMBER_HINT.search(a) or overlap:
            return True, ""
        return False, "The question asks how many/how much — no quantity in your answer."

    if qtype == "person":
        if PERSON_HINT.search(a) or overlap or VERBISH.search(a):
            return True, ""
        return False, "The question asks who — your answer does not name a person/role."

    if qtype == "reason":
        if REASON_HINT.search(a) or len(a_content) >= 3:
            return True, ""
        return False, "The question asks why — give a short reason (e.g. protože…)."

    if qtype in {"description", "what", "general"}:
        if overlap or (VERBISH.search(a) and len(a_content) >= 2):
            return True, ""
        if len(a_content) >= 3 and VERBISH.search(a):
            return True, ""
        return False, "Your answer does not clearly address the question."

    return False, "Your answer does not clearly address the question."


def grade_a2(question: str, heard: str) -> dict:
    text = (heard or "").strip()
    if not text:
        return {
            "ok": False,
            "score": 1,
            "note": "No clear speech detected — speak louder in one full Czech sentence.",
            "better": None,
        }

    words = tokens(text)
    n = len(words)
    qtype = question_type(question)
    has_verb = bool(VERBISH.search(text))
    relevant, relevance_note = answers_question(question, text, qtype)

    # Too short / not a sentence
    if n <= 2:
        return {
            "ok": False,
            "score": 2,
            "note": "Too short — answer with one full sentence (not one or two words).",
            "better": None,
        }

    if not has_verb:
        return {
            "ok": False,
            "score": 2,
            "note": "Not a full sentence — include a verb (e.g. jsem, mám, bydlím).",
            "better": None,
        }

    if not relevant:
        return {
            "ok": False,
            "score": 2,
            "note": relevance_note or "Off-topic — answer the question that was asked.",
            "better": None,
        }

    # Relevant full sentence: strict bar for 4/5
    if n >= 6 and has_verb and relevant:
        return {
            "ok": True,
            "score": 5,
            "note": "Clear full sentence that answers the question.",
            "better": None,
        }

    if n >= 4 and has_verb and relevant:
        return {
            "ok": True,
            "score": 4,
            "note": "Good — full sentence and on-topic. Add a bit more detail for a 5.",
            "better": None,
        }

    # Relevant but thin
    return {
        "ok": True,
        "score": 3,
        "note": "Partly OK, but too thin for 4/5 — use a clearer full sentence that fits the question.",
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
