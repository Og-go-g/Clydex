#!/bin/bash
# ============================================================
# Clydex N1 — Server Setup Script (Hetzner / Ubuntu 22+)
#
# Run as root on a fresh server:
#   curl -sSL https://raw.githubusercontent.com/.../setup-server.sh | bash
#
# Or step by step:
#   chmod +x scripts/setup-server.sh
#   sudo ./scripts/setup-server.sh
# ============================================================

set -euo pipefail

DOMAIN="clydex.io"
APP_DIR="/opt/clydex"
REPO_URL=""  # Set your git repo URL

echo "╔══════════════════════════════════════════╗"
echo "║   Clydex N1 — Server Setup               ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─── 1. System updates ───────────────────────────────────────
echo "[1/7] Updating system..."
apt-get update -qq && apt-get upgrade -y -qq

# ─── 2. Install Docker ───────────────────────────────────────
echo "[2/7] Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi
echo "  Docker: $(docker --version)"

# ─── 3. Install Docker Compose ────────────────────────────────
echo "[3/7] Installing Docker Compose..."
if ! command -v docker-compose &>/dev/null && ! docker compose version &>/dev/null; then
  apt-get install -y -qq docker-compose-plugin
fi
echo "  Compose: $(docker compose version --short 2>/dev/null || echo 'plugin installed')"

# ─── 4. SSL Certificates (Let's Encrypt) ─────────────────────
echo "[4/7] Setting up SSL for ${DOMAIN}..."
if ! command -v certbot &>/dev/null; then
  apt-get install -y -qq certbot
fi

if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  echo "  Generating SSL certificate..."
  certbot certonly --standalone -d "${DOMAIN}" -d "www.${DOMAIN}" --non-interactive --agree-tos --email admin@${DOMAIN}
  echo "  SSL cert generated!"
else
  echo "  SSL cert already exists."
fi

# Auto-renew cron
echo "0 0 1 * * certbot renew --quiet && docker compose -f ${APP_DIR}/docker-compose.yml restart nginx" | crontab -l 2>/dev/null | cat - | sort -u | crontab -

# ─── 5. Clone / Pull repo ────────────────────────────────────
echo "[5/7] Setting up application..."
mkdir -p "${APP_DIR}"

if [ -n "${REPO_URL}" ] && [ ! -d "${APP_DIR}/.git" ]; then
  git clone "${REPO_URL}" "${APP_DIR}"
elif [ -d "${APP_DIR}/.git" ]; then
  cd "${APP_DIR}" && git pull
fi

# ─── 6. Environment file ─────────────────────────────────────
echo "[6/7] Checking environment..."
if [ ! -f "${APP_DIR}/.env" ]; then
  echo "  WARNING: No .env file found!"
  echo "  Copy .env.example to .env and fill in your values:"
  echo "    cp ${APP_DIR}/.env.example ${APP_DIR}/.env"
  echo "    nano ${APP_DIR}/.env"
  echo ""

  # Generate CRON_SECRET if not set
  CRON_SECRET=$(openssl rand -hex 32)
  echo "  Generated CRON_SECRET: ${CRON_SECRET}"
  echo "  Add this to your .env file."
else
  echo "  .env file found."
fi

# ─── 7. Crontab ──────────────────────────────────────────────
echo "[7/7] Setting up cron jobs..."

# Read CRON_SECRET from .env if exists
if [ -f "${APP_DIR}/.env" ]; then
  CRON_SECRET=$(grep '^CRON_SECRET=' "${APP_DIR}/.env" | cut -d= -f2-)
fi

if [ -n "${CRON_SECRET:-}" ]; then
  # Daily history sync at 3am UTC
  CRON_SYNC="0 3 * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' https://${DOMAIN}/api/cron/sync-history > /dev/null 2>&1"

  # Price collection every 15 minutes
  CRON_PRICES="*/15 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' https://${DOMAIN}/api/cron/collect-prices > /dev/null 2>&1"

  # SSL renewal monthly
  CRON_SSL="0 0 1 * * certbot renew --quiet && docker compose -f ${APP_DIR}/docker-compose.yml restart nginx"

  (crontab -l 2>/dev/null | grep -v 'sync-history' | grep -v 'collect-prices' | grep -v 'certbot renew'; echo "${CRON_SYNC}"; echo "${CRON_PRICES}"; echo "${CRON_SSL}") | crontab -

  echo "  Cron jobs installed:"
  echo "    - History sync: daily 3am UTC"
  echo "    - Price collection: every 15 min"
  echo "    - SSL renewal: monthly"
else
  echo "  WARNING: CRON_SECRET not found. Set up cron manually after creating .env"
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Setup complete!                         ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║  Next steps:                             ║"
echo "║  1. cd ${APP_DIR}                        ║"
echo "║  2. cp .env.example .env                 ║"
echo "║  3. nano .env  (fill in values)          ║"
echo "║  4. docker compose up -d --build         ║"
echo "║  5. docker compose logs -f               ║"
echo "║                                          ║"
echo "╚══════════════════════════════════════════╝"
