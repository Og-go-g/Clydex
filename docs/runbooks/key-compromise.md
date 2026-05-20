# Copy-trading key compromise runbook

**Owner:** on-call (currently solo).
**Last updated:** 2026-05-20.
**Scope:** suspected or confirmed compromise of the `COPY_ENCRYPTION_KEY` master
secret OR any individual copy-trader session key signed by it.

This runbook covers the **Week 1** posture (master key still in env, but
per-action signing policy + kill switch are live). After we migrate to a TEE
(Phala dStack or similar) the steps below stay valid — only the "re-wrap" step
becomes "rotate the in-enclave wrapping key".

---

## Trigger conditions

Hit this runbook when ANY of the following is true:

- Sentry alert `policy-refused` firing in a sustained burst (>10 in 60s).
- Sentry alert `order-fill-slippage` shows `markDeviation > 0.05` repeatedly
  on a single follower.
- An external party reports a draining incident.
- `.env`, `/proc/self/environ`, a backup, or any artifact containing
  `COPY_ENCRYPTION_KEY` is leaked or suspected to be.
- `clydex-worker` container shows unauthorized exec / shell access.
- Anomaly in the copy_trades table (size spikes, off-leader trades, etc.).

When in doubt — **pause first, investigate second.** A false alarm costs
followers 15 minutes of paused signing; a missed alert costs them margin.

---

## T+0s: confirm you can authenticate

```
ssh root@168.119.236.141
cd /opt/clydex
set -a; . .env; set +a
echo "$CRON_SECRET" | head -c 6  # verify it's set
```

If you can't ssh to prod: phone a friend, escalate.

---

## T+30s: PAUSE the copy engine

```
curl -X POST http://localhost:3000/api/admin/copy/pause \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"reason":"<one-sentence reason>, op=<your-handle>"}'
```

Expected response: `{"paused":true,"reason":"..."}`.

Effect: within 2s (the `KILL_SWITCH_TTL_MS` cache window) the copy engine
stops signing new orders. Sentry breadcrumb fires (`kill-switch-flipped`).

---

## T+1m: VERIFY the pause took effect

```
# 1. Check the flag itself
psql "$HISTORY_DATABASE_URL" -c \
  "SELECT * FROM system_flags WHERE flag_name = 'copy_trading_paused';"

# 2. Watch the next two engine cycles in worker logs — no order placements
docker compose logs --tail=50 -f worker | grep -E "copy-engine|policy-refused"

# 3. Check copy_trades table for anything inserted post-pause
psql "$HISTORY_DATABASE_URL" -c \
  "SELECT created_at, follower_addr, status, error \
   FROM copy_trades \
   WHERE created_at > NOW() - INTERVAL '5 minutes' \
   ORDER BY created_at DESC \
   LIMIT 20;"
```

If you see new orders post-pause: the pause didn't take — escalate to
**full stop** (next section).

---

## T+5m: FULL STOP (if pause didn't take, or compromise is confirmed)

Take the worker offline entirely so even a bypassed kill switch can't sign:

```
docker compose stop worker
```

The app container keeps serving the UI but the copy engine no longer runs.
Users see "copy trading paused" via the existing UI status badge.

---

## T+10m: REVOKE all active on-chain delegate sessions

This is the most expensive step but it's the one that closes the door even
against an attacker who already has plaintext session keys.

We don't yet have a one-shot revocation script — write it now if missing.
It should iterate every row in `copy_sessions` and call the 01 Exchange
`revokeSession(sessionIdStr)` SDK method (see lib/copy/queries.ts for the
DB shape, lib/copy/norduser-restore.ts for how to reconstruct a NordUser).

Target: 1 RPC call per session. With ~hundreds of users this finishes in
under 2 minutes. Pace at ~5 req/s so we don't tip over our paid RPC quota.

Until that script exists, the manual fallback is to UPDATE
`copy_sessions.expires_at = NOW()` so the worker's restore step refuses
to load expired sessions — but **this only stops OUR engine from using
them, not an attacker who already extracted them**. The on-chain revoke
is the real closer.

---

## T+15m: CUSTOMER COMM

If we believe at least one user was affected, post a status update.
Template (Discord / Twitter / banner):

> We paused all copy-trading signing at HH:MM UTC after an anomaly was
> detected. No user funds can leave the exchange — only signing of new
> trades is affected. We are investigating. Followers can verify their
> own activity at <link to /api/copy/sign-log when sign_log ships>.
> Next update in 30 minutes.

If no user is affected (false alarm), still post once you resume — silent
"oops" is worse than transparent "we tested the brake".

---

## T+30m onward: ROTATE the master key (optional Week 1, mandatory Week 2+)

In Week 1 (env-based master key): generate a new 32-byte hex value,
update `COPY_ENCRYPTION_KEY` in `.env`, re-encrypt every row in
`copy_sessions` with the new key, restart worker.

Until we add `key_version` (in a later session), rotation requires
either re-wrapping every session at once or invalidating them all and
forcing users to re-activate. Choose based on user count and incident
severity.

In Week 2+ (TEE-backed): rotation is `dstack rotate-key` plus a
batch re-wrap inside the enclave. No env edit needed.

---

## T+24h: FORENSICS

- Pull the worker logs since 24h before the alert. Look for:
  - `policy-refused` patterns by follower / leader
  - unusual `order-fill-slippage` deviations
  - sign attempts outside subscription envelope
- Snapshot `copy_trades` for the affected window.
- Cross-reference with the deploy log: did we ship something around the
  time of the first anomaly?
- If `.env` is confirmed leaked: every previously issued session is
  considered compromised even if the on-chain revoke succeeded
  (durable nonces — see https://www.chainalysis.com/blog/lessons-from-the-drift-hack/).

---

## After the incident

- File a post-mortem in `docs/postmortems/YYYY-MM-DD-<short-name>.md`.
- Update this runbook with anything that worked badly.
- If applicable, fast-track the Week 2 TEE migration.

---

## What this runbook does NOT cover

- Solana RPC or 01 Exchange outage (those aren't compromise events).
- Database corruption or routine PG failures (see `/api/health` + the
  systemd `OnFailure` pipe that already exists from phase 8c).
- Loss of admin access to the box (out of scope; use your own break-glass).
