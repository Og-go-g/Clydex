# Operations — `/opt/clydex/ops`

Server-side scripts and systemd units that aren't built into Docker
images. Lives in the repo so changes are reviewable and tracked, but
deploys are manual (one-time install per server).

## Layout

```
ops/
├── bin/
│   └── clydex-alert.sh         — bash forwarder for systemd OnFailure
└── systemd/
    └── clydex-alert@.service   — template unit that runs the forwarder
```

## clydex-alert: systemd → Sentry pipeline

When a systemd unit fails (e.g. `postgresql@16-main` gets OOM-killed),
its `OnFailure=` hook starts `clydex-alert@<unit>.service`. That
template unit runs `clydex-alert.sh` which POSTs the failure context
to our app's `/api/admin/alert` endpoint, which captures it into
Sentry. Net effect: PG dies, you get a Sentry alert within seconds.

### Why this exists

Pre-2026-05-03 a PG OOM caused a SIX-DAY silent outage (memory:
postgres_oom_protection.md). Docker healthchecks didn't ping the DB,
nothing watched systemd from outside, and we only noticed when a user
reported broken portfolio history. /api/health (commit c6742fc) covers
the docker side. This pipeline covers the systemd side.

### One-time setup on a fresh server

```bash
# 1. Copy the script + unit into place
sudo cp /opt/clydex/ops/bin/clydex-alert.sh /usr/local/bin/clydex-alert.sh
sudo chmod +x /usr/local/bin/clydex-alert.sh
sudo cp /opt/clydex/ops/systemd/clydex-alert@.service /etc/systemd/system/

# 2. Create the env file the script reads (NOT in /opt/clydex/.env so
#    it doesn't bloat the prod env-file with a secret only this needs).
#    Mode 600 so only root can read.
sudo tee /etc/clydex-alert.env > /dev/null <<EOF
ALERT_URL=http://127.0.0.1:3000/api/admin/alert
ALERT_TOKEN=$(grep ^CRON_SECRET= /opt/clydex/.env | cut -d= -f2-)
EOF
sudo chmod 600 /etc/clydex-alert.env

# 3. Reload systemd so it sees the new template unit
sudo systemctl daemon-reload

# 4. Wire it into Postgres (or any other unit you want monitored)
sudo systemctl edit postgresql@16-main
# In the editor that opens, add:
#   [Service]
#   OnFailure=clydex-alert@%n.service
# Save and exit. systemd merges with the existing override.conf.

sudo systemctl daemon-reload
```

### Verifying the pipeline end-to-end

```bash
# Smoke test: trigger the alerter directly with a fake unit name.
sudo systemctl start clydex-alert@dummy.service
sudo journalctl -u clydex-alert@dummy.service -n 20 --no-pager

# Should see a payload built and a curl POST attempted (HTTP 202 if
# /api/admin/alert is up). Open Sentry; the captured event should
# have:
#   - level: fatal
#   - message: "systemd unit failed: dummy"
#   - tags: alert.source=systemd:dummy, alert.channel=systemd-hook,
#           unit=dummy, host=<your hostname>
#   - context "alert.extra": { time, recentLog, unitStatus }

# Real test: kill PG and confirm a real alert fires within ~5s.
# WARNING: production users will see brief downtime.
sudo systemctl kill --signal=SIGKILL postgresql@16-main
# Wait ~5s, check Sentry for the systemd:postgresql@16-main event,
# then bring PG back up:
sudo systemctl start postgresql@16-main
```

### Failure modes the script handles

- `/etc/clydex-alert.env` missing or unreadable — log to journal, exit 0.
- Network down / app down — short curl timeout (8 s), log HTTP code, exit 0.
- jq not installed — falls back to hand-rolled JSON escaping.
- journalctl unavailable — sends `<journalctl unavailable>` placeholder.

The script ALWAYS exits 0 to prevent its own failure from triggering
its own OnFailure hook (would create an infinite cascade).

### Updating the script after a code change

Local change → push to main → on the server:

```bash
ssh root@168.119.236.141
cd /opt/clydex && git pull
sudo cp ops/bin/clydex-alert.sh /usr/local/bin/clydex-alert.sh
# No daemon-reload needed — script changes are picked up on next exec.

# If the .service template changed:
sudo cp ops/systemd/clydex-alert@.service /etc/systemd/system/
sudo systemctl daemon-reload
```
