# A2 Speaking Practice · Úloha 1

Practice the Czech permanent-residence A2 oral exam (Task 1) with Google AI voice.

Each session picks **2 random topics** and asks **4 questions** from each (8 total), like the exam: you hear the question, answer in one full sentence, then get a short score/note.

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

Allow microphone access when the browser asks.

## Flow

1. **Start practice** — 2 topics appear in the sidebar (highlighted).
2. Examiner speaks each question (pre-baked Piper Czech audio — no TTS quota).
3. **Press to answer** — recording stops → next question starts immediately; Gemini scores in the background.
4. After 8 answers, the summary waits for any leftover scores.

Optional: **Show question text** if you want to read as well as listen.

## Examiner audio

All 289 questions are stored as MP3 under `assets/audio/questions/`  
(Microsoft Edge TTS **cs-CZ-VlastaNeural** — clear Czech female voice).  
`api/speak.php` serves those first; Gemini TTS is only a fallback.

To regenerate after editing questions:

```bash
# default: Edge TTS Vlasta (needs edge-tts). Alt: --engine piper (Kasandra)
python3 tools/generate-question-audio.py --force
```

## Source

Questions are drawn from `Speaking-T1.pdf` (iLearnCzech A2 oral materials), organized into the 10 official topics.

## Production

- Live: `https://speaking.numbertools.eu/`
- Deploy: GitHub Actions → Hostinger — see [`docs/deploy-hostinger.md`](docs/deploy-hostinger.md)
