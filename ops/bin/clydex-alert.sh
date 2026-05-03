#!/usr/bin/env bash
#
# clydex-alert.sh — forward a systemd unit failure into our Sentry
# pipeline via /api/admin/alert.
#
# Usage:   clydex-alert.sh <unit-name>
# Example: clydex-alert.sh postgresql@16-main.service
#
# Wired via systemd's `OnFailure=` directive. See
# ops/systemd/clydex-alert@.service for the template unit and
# memory/postgres_oom_protection.md for installation instructions.
#
# This script is intentionally minimal — only bash + curl, no Node /
# Python / external deps. Has to run even when the box is in a bad
# state (PG dead, app under stress, etc).
#
# Behavior:
#   - Reads ALERT_URL and ALERT_TOKEN from /etc/clydex-alert.env
#     (separate from /opt/clydex/.env so it doesn't grow the prod
#     env-file with a secret only this script needs).
#   - POSTs JSON to ALERT_URL with the unit's failure context.
#   - Always writes to local journal (`logger -t clydex-alert ...`)
#     even if the HTTP call fails — that's the last-ditch trail
#     if Sentry+app are both down.
#   - Exits 0 even on HTTP failure: a failed alerter must not loop
#     trigger systemd's OnFailure for itself.

set -u
# Note: NO `set -e` — partial failures must not abort journaling.

UNIT="${1:-unknown}"
HOST="$(hostname 2>/dev/null || echo unknown)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Pull last few lines of the failed unit's journal for context.
# Truncate to keep the alert payload small.
RECENT_LOG="$(journalctl -u "$UNIT" -n 20 --no-pager 2>/dev/null | tail -c 4000 || echo '<journalctl unavailable>')"

# Pull systemd's view of why the unit failed.
UNIT_STATUS="$(systemctl show "$UNIT" -p ActiveState -p SubState -p Result -p ExecMainStatus 2>/dev/null || echo '<systemctl unavailable>')"

# Always log locally — survives even if the HTTP call below fails.
logger -t clydex-alert "unit=$UNIT host=$HOST: failure detected at $NOW"

# Load alerter credentials. Do NOT fail loudly if missing — just log
# and exit so we don't recurse into our own OnFailure.
ENV_FILE="/etc/clydex-alert.env"
if [[ ! -r "$ENV_FILE" ]]; then
  logger -t clydex-alert "missing $ENV_FILE — skipping HTTP forward"
  exit 0
fi
# shellcheck source=/dev/null
. "$ENV_FILE"

if [[ -z "${ALERT_URL:-}" || -z "${ALERT_TOKEN:-}" ]]; then
  logger -t clydex-alert "ALERT_URL or ALERT_TOKEN missing in $ENV_FILE — skipping HTTP forward"
  exit 0
fi

# Build JSON payload. Use jq if present (handles escaping properly),
# fall back to a hand-rolled escape for environments without jq.
if command -v jq >/dev/null 2>&1; then
  PAYLOAD="$(jq -n \
    --arg source "systemd:$UNIT" \
    --arg level "fatal" \
    --arg message "systemd unit failed: $UNIT" \
    --arg host "$HOST" \
    --arg unit "$UNIT" \
    --arg time "$NOW" \
    --arg log "$RECENT_LOG" \
    --arg status "$UNIT_STATUS" \
    '{source: $source, level: $level, message: $message,
      tags: {unit: $unit, host: $host},
      extra: {time: $time, recentLog: $log, unitStatus: $status}}')"
else
  # Hand-rolled escape for hosts without jq. Strips control chars and
  # double quotes from log/status — good enough for an alert payload.
  esc() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/"/\\"/g'; }
  PAYLOAD="{\"source\":\"systemd:$(esc "$UNIT")\",\"level\":\"fatal\",\"message\":\"systemd unit failed: $(esc "$UNIT")\",\"tags\":{\"unit\":\"$(esc "$UNIT")\",\"host\":\"$(esc "$HOST")\"},\"extra\":{\"time\":\"$NOW\",\"recentLog\":\"$(esc "$RECENT_LOG")\",\"unitStatus\":\"$(esc "$UNIT_STATUS")\"}}"
fi

# Fire-and-forget POST with a tight timeout. If the app is also down
# we don't want to hang the alerter forever waiting for a TCP reset.
HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
  --max-time 8 \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ALERT_TOKEN" \
  --data "$PAYLOAD" \
  "$ALERT_URL" 2>&1 || echo 'curl-error')"

logger -t clydex-alert "POST $ALERT_URL -> $HTTP_CODE"

# Always exit 0 so a failing alerter doesn't itself trigger OnFailure
# (which would create an infinite loop).
exit 0
