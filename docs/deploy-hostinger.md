# Deploy to Hostinger (speaking.numbertools.eu)

Static HTML + PHP API. Deploys via SSH + rsync from GitHub Actions (same pattern as vocabulary).

## Target URLs

| Role | URL |
|------|-----|
| Canonical (after cutover) | `https://speaking.numbertools.eu` |
| **Live now** | `https://vocabulary.numbertools.io/speaking/` |
| After dedicated subdomain | `https://speaking.numbertools.io` → redirect to `.eu` |

## GitHub secrets

| Secret | Value |
|--------|--------|
| `SSH_HOST` | `82.198.229.215` |
| `SSH_USER` | `u712052388` |
| `SSH_PORT` | `65002` |
| `SSH_KEY` | contents of `~/.ssh/hostinger_czech_deploy` |
| `DEPLOY_PATH` | see below |
| `GEMINI_API_KEY` | Gemini / AI Studio key (creates `config.local.php` once) |

### DEPLOY_PATH

**Live now (path under vocabulary site):**

`/home/u712052388/domains/vocabulary.numbertools.io/public_html/speaking`

**After creating subdomain `speaking.numbertools.eu` in hPanel:**

`/home/u712052388/domains/speaking.numbertools.eu/public_html`

Then update the `DEPLOY_PATH` GitHub secret and re-run the workflow.

## Domain cutover (numbertools.eu)

`numbertools.eu` is currently on Hostinger **DNS parking**. Before subdomains work:

1. hPanel → **Domains** → connect / assign `numbertools.eu` to this hosting
2. Use Hostinger nameservers (or A record to this account’s IP)
3. Create subdomains: `speaking`, `vocabulary`, `czech`, …
4. Update each repo’s `DEPLOY_PATH` secret
5. Put redirect `.htaccess` on each `.io` site (see `docs/redirect-io-to-eu.md` in this folder)

## Manual deploy

```bash
export SSH_HOST=82.198.229.215
export SSH_USER=u712052388
export SSH_PORT=65002
export REMOTE_PATH=/home/u712052388/public_html/speaking

rsync -avz --delete \
  --exclude '.git/' \
  --exclude '.github/' \
  --exclude 'config.local.php' \
  -e "ssh -i ~/.ssh/hostinger_czech_deploy -p ${SSH_PORT}" \
  ./ "${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}/"
```

Then copy `config.local.php` once if Actions secret was not set.
