# Czech speaking STT (Contabo)

CPU Whisper (`faster-whisper`, model `base`) for speaking.numbertools.eu listen/score.

## Deploy

```bash
# on Contabo
cd /opt/czech-speaking-stt
cp .env.example .env   # set STT_API_KEY
docker compose up -d --build
curl http://127.0.0.1:8091/health
```

Speaking site `config.local.php`:

```php
'stt_url' => 'http://169.58.149.75:8091',
'stt_api_key' => '…',
```

## Firewall

Port **8091** is restricted on Contabo to the Hostinger `numbertools.eu` server only:

- Allow: `82.198.228.108` (speaking/vocabulary Hostinger box)
- Drop: all other sources
- Persist: `czech-stt-firewall.service` → `/usr/local/sbin/czech-stt-firewall.sh`

API key is still required as a second layer.

## Endpoints

| Path | Use |
|------|-----|
| `GET /health` | Liveness |
| `POST /v1/answer` | Task 1 — form fields `question` + `audio` |
| `POST /v1/ask` | Task 2 — form fields `situation`, `hint`, `model_question`, `is_free` (`0`/`1`) + `audio` |

`/v1/ask` scores interrogative form, formal *vy*, and match to the card hint (or situation relevance for the free question). Notes are in English; score 1–5.

## Models

| Model | RAM (int8) | Quality |
|-------|------------|---------|
| `tiny` | ~0.4 GB | weakest |
| `base` | ~0.5 GB | **default** — good for A2 |
| `small` | ~1.3 GB | better; set `WHISPER_MODEL=small` if RAM allows |
