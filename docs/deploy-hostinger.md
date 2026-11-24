# Deploy to Hostinger (speaking.numbertools.eu)

Static HTML + PHP API. Deploys via SSH + rsync from GitHub Actions (same pattern as vocabulary).

## Target URLs

| Role | URL |
|------|-----|
| Canonical | `https://speaking.numbertools.eu` |
| Apex hub | `https://numbertools.eu` |
| Old path redirect | `https://vocabulary.numbertools.io/speaking/` → `.eu` |

## GitHub secrets

| Secret | Value |
|--------|--------|
| `SSH_HOST` | `82.198.228.108` |
| `SSH_USER` | `u659505911` |
| `SSH_PORT` | `65002` |
| `SSH_KEY` | contents of `~/.ssh/hostinger_czech_deploy` |
| `DEPLOY_PATH` | `/home/u659505911/domains/speaking.numbertools.eu/public_html` |
| `GEMINI_API_KEY` | Gemini / AI Studio key (creates `config.local.php` once) |

## Manual deploy

```bash
export SSH_HOST=82.198.228.108
export SSH_USER=u659505911
export SSH_PORT=65002
export REMOTE_PATH=/home/u659505911/domains/speaking.numbertools.eu/public_html

rsync -avz --delete \
  --exclude '.git/' \
  --exclude '.github/' \
  --exclude 'config.local.php' \
  -e "ssh -i ~/.ssh/hostinger_czech_deploy -p ${SSH_PORT}" \
  ./ "${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}/"
```

Then copy `config.local.php` once if Actions secret was not set.
