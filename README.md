# A2 Speaking Practice · Úloha 1 + 2

Practice the Czech permanent-residence A2 oral exam with Google AI / Whisper.

| Task | What you do |
|------|-------------|
| **Úloha 1** — Otázky | Answer examiner questions (2 topics × N questions) |
| **Úloha 2** — Dialogy | Ask 4 questions in each of 2 situations (3 from card hints + 1 own) |

## Setup

1. Copy the config and add your [Google AI Studio](https://aistudio.google.com/apikey) key:

```bash
cp config.local.php.example config.local.php
# edit config.local.php → paste google_api_key
```

2. Serve the folder with PHP (needs `curl` enabled):

```bash
cd speaking-practice
php -S localhost:8080
```

3. Open http://localhost:8080

Allow microphone access when the browser asks. Use the sidebar tabs to switch **Úloha 1** / **Úloha 2**.

## Úloha 1 flow

1. **Start practice** — 2 topics appear in the sidebar (highlighted).
2. Examiner speaks each question (pre-baked Piper Czech audio — no TTS quota).
3. **Press to answer** — recording stops → next question starts immediately; Gemini/Whisper scores in the background.
4. After answers, the summary waits for any leftover scores.

Optional: **Show question text** if you want to read as well as listen.

## Úloha 2 flow

1. Pick situations in the sidebar (or leave empty → random **2 dialogues**).
2. **Start dialogues** — examiner greets; the scenario card shows 3 hints + “vaše otázka”.
3. **Press to ask** — you ask a formal *vy* question; examiner replies; scoring runs in the background.
4. After 4 questions, the dialogue closes and the second situation starts (8 asks total).

Situations live in `assets/data/dialogues.json` (hotel, repair shop, shoe shop, flat viewing, pharmacy, post, train, restaurant, doctor, hairdresser, library, cinema).

## Examiner audio

**Úloha 1** questions are stored as MP3 under `assets/audio/questions/{male,female}/`.  
The examiner is always a **woman** (Edge TTS **cs-CZ-VlastaNeural**).  
Folders only change grammar addressed to the candidate — slash forms like
`rád/a` become *rád* or *ráda* (not “rád nebo a”).

| Folder    | Candidate form | Default on page |
|-----------|----------------|-----------------|
| `male/`   | rád, dělal, nemocný… | yes |
| `female/` | ráda, dělala, nemocná… | |

`api/speak.php` serves those first; Gemini TTS is only a fallback.

**Úloha 2** openings/replies use live TTS via `api/speak.php` (no pre-baked bank yet).

To regenerate Task 1 audio after editing questions:

```bash
# both candidate forms, Vlasta voice (needs edge-tts)
.venv-tts/bin/python tools/generate-question-audio.py --force
# preview slash resolutions only:
.venv-tts/bin/python tools/generate-question-audio.py --dry-run
```

## Scoring (STT)

Prefer local Whisper on Contabo (`stt_url` in config). Endpoints:

- `POST /v1/answer` — Task 1 (grade spoken **answers**)
- `POST /v1/ask` — Task 2 (grade spoken **questions**: interrogative form, formal *vy*, hint match)

See [`stt-server/README.md`](stt-server/README.md). Redeploy the VPS image after pulling `/v1/ask` changes.

## Source

- Task 1 questions: `Speaking-T1.pdf` (iLearnCzech A2 oral materials), 10 official topics.
- Task 2 format: official model tests (cestina-pro-cizince.cz) from April 2026 — 3 prompts + 1 free question per dialogue.

## Production

- Live: `https://speaking.numbertools.eu/`
- Deploy: GitHub Actions → Hostinger — see [`docs/deploy-hostinger.md`](docs/deploy-hostinger.md)
