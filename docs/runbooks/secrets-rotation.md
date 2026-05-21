# Secrets management runbook

**Owner:** on-call (currently solo).
**Last updated:** 2026-05-21.
**Scope:** sops + age workflow for `.env.local` / `.env.production`,
  rotating the age key, rotating the master encryption key
  (`COPY_ENCRYPTION_KEY`), and the production deploy story.

---

## Why this exists

The pre-2026-05-21 setup stored plaintext secrets in `.env.local` on
disk. Reading the file required either shell access OR a leaked
filesystem backup. Both are too easy: a contractor on the box, a
careless `tar`, or a stolen disk image all expose every key the app
has.

`sops` + `age` encrypts those values **at rest**. The encrypted file
(`.env.local.sops`) is safe to commit to git. The plaintext
(`.env.local`) is generated on demand from the encrypted source,
gitignored, and lives only as long as the running process needs it.

The age private key (`~/.config/sops/age/keys.txt`) is the single
trust root. Lose it → no decryption. Leak it → equivalent to leaking
all secrets. Treat it the way you'd treat a Yubikey: one copy on the
operator's laptop, one offline backup, never in cloud sync.

---

## Daily / per-developer workflow

```bash
# After cloning fresh OR pulling a teammate's .env.local.sops change:
npm run env:decrypt

# Edit a value (opens $EDITOR with decrypted view, re-encrypts on save):
npm run env:edit

# After hand-editing .env.local for testing, sync back to encrypted:
npm run env:encrypt
```

The pre-commit hook (`scripts/env-precommit-check.sh`) refuses
commits that contain plaintext `.env*` files or `.sops` files
missing their encryption envelope. If it fires, read the message —
it tells you exactly what to do.

---

## Generating the age key (first-time setup on a new machine)

```bash
mkdir -p ~/.config/sops/age
age-keygen -o ~/.config/sops/age/keys.txt
chmod 600 ~/.config/sops/age/keys.txt

# Read the public key (starts with `age1...`) — share this with
# whoever maintains `.sops.yaml` so they can add you to the
# recipients list.
grep "^# public key:" ~/.config/sops/age/keys.txt
```

Back up the private key to ONE offline location (USB drive, paper
wallet, password manager's secure note). Do not put it in
Dropbox/iCloud/sync — they all index/snapshot files and a future
sync compromise leaks the key.

---

## Adding a recipient (e.g. a teammate joins)

1. Teammate generates their own age key (see above), shares
   their `age1...` public key.
2. Append their pubkey to `.sops.yaml` under `age:`, comma-separated:
   ```yaml
   creation_rules:
     - path_regex: "\\.env(\\..*)?(\\.sops)?$"
       age: age1aaa...,age1bbb...
   ```
3. Re-encrypt all existing `*.sops` files to add the new envelope:
   ```bash
   sops updatekeys .env.local.sops
   ```
4. Commit `.sops.yaml` + updated `.env.local.sops`. Teammate pulls
   and runs `npm run env:decrypt`.

---

## Production rollout (Hetzner)

**Goal**: prod box at `/opt/clydex` decrypts secrets at container
start, never stores plaintext on disk persistently. Two viable
approaches; pick A unless you have a specific reason for B.

### A — sops exec-env inside Docker (recommended)

Steps:

1. **On the prod box** (`ssh root@168.119.236.141`), generate the
   production age key:
   ```bash
   mkdir -p /etc/clydex/sops
   chmod 700 /etc/clydex/sops
   age-keygen -o /etc/clydex/sops/keys.txt
   chmod 600 /etc/clydex/sops/keys.txt
   grep "^# public key:" /etc/clydex/sops/keys.txt
   ```
2. **On your laptop**, add the prod pubkey to `.sops.yaml`:
   ```yaml
   age: <dev-pubkey>,<prod-pubkey>
   ```
3. **Locally**, run `sops updatekeys .env.local.sops` so the
   encrypted file's envelope now includes the prod recipient.
4. Move secrets from `.env.local` shape to `.env.production` shape
   (different DB URLs, no localhost, etc.). Encrypt with sops the
   same way:
   ```bash
   sops --encrypt --input-type=dotenv --output-type=dotenv .env.production > .env.production.sops
   ```
5. Commit `.env.production.sops` + the updated `.sops.yaml`.
6. **On prod**, pull and update docker-compose to wrap the app
   command in `sops exec-env`:
   ```yaml
   services:
     app:
       command:
         - sops
         - exec-env
         - /app/.env.production
         - npm start
       volumes:
         - /etc/clydex/sops/keys.txt:/root/.config/sops/age/keys.txt:ro
   ```
   Where `/app/.env.production` inside the container is a temp-rename
   of `.env.production.sops` (sops's exec-env needs an `.env`-ish
   extension for format auto-detection):
   ```dockerfile
   COPY .env.production.sops /app/.env.production
   ```
   (Yes, the file is encrypted — it's only the filename that's
   misleading for sops's sake.)
7. Restart:
   ```bash
   cd /opt/clydex && docker compose up -d --force-recreate app
   ```
8. Verify: `docker compose logs app | head -20` should show the
   normal "Ready in Xms" line. If it shows "Could not unmarshal
   input data" → wrong file format detection. If it shows "no
   matching creation rules" → .sops.yaml not visible to the
   container (mount it in).

### B — decrypt-to-disk at container start

Slightly less secure (plaintext written to a tmpfs in the
container's `/run/secrets`) but easier to debug. Skip unless A
fails for environmental reasons.

```yaml
services:
  app:
    entrypoint:
      - /bin/sh
      - -c
      - "sops -d --input-type=dotenv --output-type=dotenv /app/.env.production > /run/secrets/.env && source /run/secrets/.env && exec npm start"
    tmpfs:
      - /run/secrets:size=1m,mode=600
    volumes:
      - /etc/clydex/sops/keys.txt:/root/.config/sops/age/keys.txt:ro
```

---

## Rotating the age key

Do this when:
- A laptop is lost / stolen.
- The age key file is suspected leaked.
- Quarterly / annual rotation policy (good hygiene even without
  incident).

```bash
# 1. Generate the new key on a SAFE machine (not the suspected-
#    compromised one).
age-keygen -o ~/.config/sops/age/keys.new.txt

# 2. Update .sops.yaml to include BOTH old and new pubkeys.
#    (Don't remove the old yet — you need it to decrypt current
#    files.)

# 3. Re-encrypt every secret file so the new key gets an envelope:
sops updatekeys .env.local.sops
sops updatekeys .env.production.sops

# 4. Now swap. .sops.yaml: remove old pubkey, keep only new.
# 5. Run updatekeys ONE MORE TIME to remove the old envelope:
sops updatekeys .env.local.sops
sops updatekeys .env.production.sops

# 6. Rename new key into place + back up.
mv ~/.config/sops/age/keys.new.txt ~/.config/sops/age/keys.txt
chmod 600 ~/.config/sops/age/keys.txt

# 7. Commit changes. Burn (shred -u) the old key file from disk.
```

If you cannot recover the OLD age key (it's truly gone) and need to
rotate forward, every secret value must be manually re-typed into a
fresh `.env.local` and re-encrypted. Backup pain.

---

## Rotating COPY_ENCRYPTION_KEY (the master session-key secret)

This is the key that decrypts every copy-trader's session secret in
the DB. Rotation is more involved because we need to re-encrypt
every session blob with the new key BEFORE swapping the env value.

See `docs/runbooks/key-compromise.md` for the "rotate under
incident" playbook. The non-incident periodic rotation is:

```bash
# 1. Pause copy engine.
curl -X POST .../api/admin/copy/pause -H "Authorization: Bearer $CRON_SECRET" \
     -d '{"reason":"key rotation, op=...""}' -H 'Content-Type: application/json'

# 2. Generate new key.
openssl rand -hex 32  # → NEW_KEY

# 3. Dry-run the rotation script first to surface any rows that
#    can't be decrypted with the OLD key (partial-rotation residue,
#    schema drift, etc.). No DB writes happen on dry-run.
NEW_COPY_ENCRYPTION_KEY=$NEW_KEY tsx scripts/rotate-copy-key.ts --dry-run

# 4. If dry-run reports zero failures, run live:
NEW_COPY_ENCRYPTION_KEY=$NEW_KEY tsx scripts/rotate-copy-key.ts

#    The script wraps every UPDATE in a single transaction with
#    LOCK TABLE ACCESS EXCLUSIVE — either all rows rotate or none
#    do. On any failure mid-loop, ROLLBACK leaves the DB untouched.

# 5. Update .env.local.sops with NEW_KEY via `npm run env:edit`.

# 6. Deploy (pull, restart app).

# 7. Resume copy engine.
```

---

## Common failure modes & fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `error loading config: no matching creation rules found` | `.sops.yaml` regex doesn't match the filename | Adjust `path_regex` or rename the file. |
| `failed to create reader for decrypting sops data key with age: identity did not match any of the recipients` | The age key on the machine isn't a recipient of this file | Re-add via `sops updatekeys`, OR set `SOPS_AGE_KEY_FILE` to the right key path. |
| `Could not unmarshal input data: invalid character '#' looking for beginning of value` | sops can't autodetect dotenv format (probably wrong extension) | Add `--input-type=dotenv` flag, or rename file to end in `.env`. |
| Pre-commit hook blocks every commit | Stale `.env.local` is tracked | `git rm --cached .env.local && git commit`. The hook should then only fire when you `git add -f` plaintext. |
| `npm run env:decrypt` refuses with "differs from .env.local.sops" | You edited `.env.local` without re-encrypting | Either `npm run env:encrypt` first (keep your edits) or `rm .env.local && npm run env:decrypt` (discard them). |

---

## Threat model (what this DOES and DOES NOT protect)

**Mitigates:**
- Disk image / filesystem backup leakage. The encrypted blob is
  worthless without the age key.
- Accidental git commit of plaintext (pre-commit hook + gitignore).
- Multiple-attack-vector compromise where the attacker has read
  access to the repo but not the operator's `~/.config`.

**Does NOT mitigate:**
- Active host compromise where the attacker can read both the .env
  AND ~/.config/sops/age/keys.txt. Mitigation: TEE migration (Phala
  dStack) — out of scope for the $0-budget tier.
- Memory dumps of the running process. Mitigation: same as above.
- Phishing of the operator. Mitigation: out of scope of this
  document.
- Anything app-level (SQL injection, bad business logic, etc.).
  Different layer of defense.

For higher tiers see `docs/runbooks/key-compromise.md` and the
TEE deferral note at [[off_box_signlog_deferred]].
