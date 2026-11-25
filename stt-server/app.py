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
MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
CPU_THREADS = int(os.environ.get("WHISPER_THREADS", "4"))

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

    # Relevant full sentence: 4/5 only when on-topic + real sentence
    if n >= 6 and has_verb and relevant:
        return {
            "ok": True,
            "score": 5,
            "note": "Clear full sentence that answers the question.",
            "better": None,
        }

    if n >= 3 and has_verb and relevant:
        return {
            "ok": True,
            "score": 4,
            "note": "Good — full sentence and on-topic. Add a bit more detail for a 5.",
            "better": None,
        }

    # Relevant but somehow still thin
    return {
        "ok": True,
        "score": 3,
        "note": "Partly OK, but too thin for 4/5 — use a clearer full sentence that fits the question.",
        "better": None,
    }


QUESTION_WORD = re.compile(
    r"\b(kolik|kde|kdy|kdo|proč|jak|jaký|jaká|jaké|jakou|jací|co|který|která|které|"
    r"v\s+kolik|od\s+kdy|do\s+kdy|jak\s+dlouho|jak\s+často)\b",
    re.I,
)

# Verb-first yes/no questions with formal vy (or 1st person můžu)
ASK_VERB_START = re.compile(
    r"^(dobrý\s+den[,.]?\s+)?("
    r"máte|můžete|můžu|mohu|je\b|jsou\b|bude|budete|"
    r"dáte|dá|funguje|existuje|prodáváte|opravujete|"
    r"přijímáte|objednáte|rezervujete|otevíráte|zavíráte"
    r")\b",
    re.I,
)

INFORMAL_TY = re.compile(
    r"\b(máš|můžeš|mohouš|jsi|bys|chceš|víš|řekneš|dáš|umíš|znáš)\b",
    re.I,
)

HINT_KEYWORD_MAP = {
    "kč": ["kolik", "stojí", "cena", "stát", "korun", "platit", "nájem", "zaplat"],
    "cena": ["kolik", "stojí", "cena", "stát", "korun"],
    "volný": ["volný", "volná", "volné", "máte", "volno"],
    "pokoj": ["pokoj", "ubytování", "noc", "noci"],
    "hodina": ["hodin", "v kolik", "kdy", "od", "do", "čas"],
    "snídan": ["snídan"],
    "oprav": ["oprav", "opravit", "servis", "rozbit"],
    "dob": ["jak dlouho", "trvá", "trvat", "doba", "týden", "dn"],
    "velikost": ["velikost", "velikosti", "číslo", "máte"],
    "materiál": ["materiál", "kožen", "látk", "z čeho"],
    "pes": ["pes", "psa", "zvíře", "zvířata", "domácí"],
    "stěhov": ["nastěhovat", "stěhovat", "volný", "od kdy", "kdy"],
    "datum": ["kdy", "datum", "od", "termín"],
    "lék": ["lék", "tablety", "bolest", "máte"],
    "brát": ["brát", "užívat", "jak často", "kolikrát", "denně"],
    "poslat": ["poslat", "zásilka", "balík", "do"],
    "trvá": ["jak dlouho", "trvá", "trvat", "dní", "dnů"],
    "jízden": ["jízden", "lístek", "vlak", "máte"],
    "stůl": ["stůl", "stolek", "rezerv", "volný", "míst"],
    "menu": ["menu", "jídelní", "vegetarián", "jídlo"],
    "termín": ["termín", "objednat", "kdy", "volný"],
    "pojišt": ["pojišt", "kartičk"],
    "střih": ["střih", "ostříhat", "vlasy", "termín"],
    "registr": ["registr", "zaregistrovat", "členství", "průkaz"],
    "půjč": ["půjč", "vypůjč", "jak dlouho", "měsíc"],
    "líst": ["líst", "vstupenk", "máte", "míst"],
}


def looks_like_question(text: str) -> bool:
    t = fold(text).rstrip()
    if t.endswith("?"):
        return True
    if QUESTION_WORD.search(t):
        return True
    if ASK_VERB_START.search(t):
        return True
    return False


def hint_matches(hint: str, heard: str, model_question: str = "") -> bool:
    """Loose match: hint keywords or model-question content overlap."""
    h = fold(hint)
    a = fold(heard)
    if not h or "vaše otázka" in h or h.startswith("…"):
        return True

    # Direct keyword map from hint fragments
    for key, words in HINT_KEYWORD_MAP.items():
        if key in h:
            if any(w in a for w in words):
                return True

    # Content overlap with hint tokens
    hint_toks = content_tokens(hint)
    heard_toks = content_tokens(heard)
    if hint_toks and (hint_toks & heard_toks):
        return True

    # Overlap with model question content
    if model_question:
        mq = content_tokens(model_question)
        if mq and len(mq & heard_toks) >= 1:
            return True
        # Shared question-word type
        if QUESTION_WORD.search(fold(model_question)) and QUESTION_WORD.search(a):
            mq_type = question_type(model_question)
            heard_type = question_type(heard if looks_like_question(heard) else model_question)
            if mq_type == heard_type and mq_type != "general":
                return True

    # Price hints often just "Kč?"
    if "kč" in h or "cena" in h:
        if re.search(r"\b(kolik|stojí|cena|korun|platit)\b", a):
            return True

    return False


def situation_relevant(situation: str, heard: str) -> bool:
    s_toks = content_tokens(situation)
    a_toks = content_tokens(heard)
    if not a_toks:
        return False
    if s_toks & a_toks:
        return True
    # Any clear question in a service dialogue is usually OK for free Q
    return looks_like_question(heard) and len(tokens(heard)) >= 3


def grade_ask(
    situation: str,
    hint: str,
    heard: str,
    model_question: str = "",
    is_free: bool = False,
) -> dict:
    text = (heard or "").strip()
    better = model_question.strip() or None

    if not text:
        return {
            "ok": False,
            "score": 1,
            "note": "No clear speech detected — ask one clear Czech question.",
            "better": better,
        }

    words = tokens(text)
    n = len(words)

    if INFORMAL_TY.search(text):
        return {
            "ok": False,
            "score": 2,
            "note": "Use formal vy (máte/můžete), not informal ty (máš/můžeš).",
            "better": better,
        }

    if n <= 2:
        return {
            "ok": False,
            "score": 2,
            "note": "Too short — ask a full question (e.g. Kolik to stojí?).",
            "better": better,
        }

    if not looks_like_question(text):
        return {
            "ok": False,
            "score": 2,
            "note": "Not a question — use a question word (kolik, kde, kdy…) or verb-first form (Máte…?).",
            "better": better,
        }

    if is_free:
        relevant = situation_relevant(situation, text)
        if not relevant:
            return {
                "ok": False,
                "score": 2,
                "note": "Your free question should relate to this situation.",
                "better": better,
            }
    else:
        relevant = hint_matches(hint, text, model_question)
        if not relevant:
            return {
                "ok": False,
                "score": 2,
                "note": f"Off-topic for the hint ({hint or 'info'}) — ask for that information.",
                "better": better,
            }

    if n >= 5:
        return {
            "ok": True,
            "score": 5,
            "note": "Clear formal question that fits the prompt.",
            "better": better if fold(text) != fold(model_question or "") else None,
        }

    if n >= 3:
        return {
            "ok": True,
            "score": 4,
            "note": "Good question. A slightly fuller form would earn a 5.",
            "better": better,
        }

    return {
        "ok": True,
        "score": 3,
        "note": "Partly OK — make the question clearer and fully formal.",
        "better": better,
    }


def transcribe_file(path: Path, question: str = "", *, as_question: bool = False) -> str:
    assert model is not None
    if as_question:
        prompt = (
            "Česká mluvená otázka u zkoušky A2. "
            + (f"Vzor: {question.strip()} " if question.strip() else "")
            + "Uchazeč se ptá formálně (vy). Otázka celou větou."
        )
    else:
        # Bias decoder toward Czech A2 vocabulary from the exam question.
        prompt = (
            "Česká mluvená odpověď na otázku A2. "
            + (f"Otázka: {question.strip()} " if question.strip() else "")
            + "Odpověď celou větou."
        )
    segments, _info = model.transcribe(
        str(path),
        language="cs",
        task="transcribe",
        beam_size=5,
        best_of=5,
        temperature=0.0,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=250),
        condition_on_previous_text=False,
        without_timestamps=True,
        initial_prompt=prompt[:224],
    )
    parts = [seg.text.strip() for seg in segments if seg.text and seg.text.strip()]
    return " ".join(parts).strip()


async def _read_audio_tmp(audio: UploadFile) -> Path:
    suffix = Path(audio.filename or "clip.webm").suffix or ".webm"
    raw = await audio.read()
    if len(raw) < 200:
        raise HTTPException(status_code=400, detail="Audio too short")
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
        return Path(tmp.name)


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
    tmp_path = await _read_audio_tmp(audio)
    try:
        heard = transcribe_file(tmp_path, question)
    finally:
        tmp_path.unlink(missing_ok=True)

    graded = grade_a2(question, heard)
    return GradeOut(heard=heard, **graded)


@app.post("/v1/ask", response_model=GradeOut, dependencies=[Depends(require_key)])
async def ask(
    situation: str = Form(...),
    audio: UploadFile = File(...),
    hint: str = Form(""),
    model_question: str = Form(""),
    is_free: str = Form("0"),
) -> GradeOut:
    free = is_free.strip() in {"1", "true", "True", "yes"}
    tmp_path = await _read_audio_tmp(audio)
    try:
        bias = model_question or hint or situation
        heard = transcribe_file(tmp_path, bias, as_question=True)
    finally:
        tmp_path.unlink(missing_ok=True)

    graded = grade_ask(situation, hint, heard, model_question, free)
    return GradeOut(heard=heard, **graded)
