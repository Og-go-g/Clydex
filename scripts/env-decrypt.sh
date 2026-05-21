#!/usr/bin/env bash
# Decrypt .env.local.sops → .env.local with conflict protection.
#
# Run after a fresh clone, or after pulling a teammate's
# .env.local.sops change. Refuses to overwrite a local .env.local
# whose content doesn't match the encrypted source — that would
# silently lose un-committed changes.
#
# Workflow:
#   - You edited .env.local but didn't re-encrypt → this script
#     warns and exits. Run `npm run env:encrypt` first, OR diff
#     and discard manually.
#   - .env.local is fresh / missing / matches → script writes the
#     decrypted plaintext.

set -euo pipefail

if [ ! -f .env.local.sops ]; then
  echo "[env-decrypt] ❌ .env.local.sops not found in $(pwd)."
  exit 1
fi

# sops needs an age key to decrypt. Most users keep it in the
# XDG-standard path; fall back to the env var if they put it
# elsewhere.
default_age_key="$HOME/.config/sops/age/keys.txt"
if [ -z "${SOPS_AGE_KEY_FILE:-}" ] && [ -f "$default_age_key" ]; then
  export SOPS_AGE_KEY_FILE="$default_age_key"
fi
if [ -z "${SOPS_AGE_KEY_FILE:-}" ] || [ ! -f "$SOPS_AGE_KEY_FILE" ]; then
  echo "[env-decrypt] ❌ No age key found."
  echo "             Generate one: \`age-keygen -o ~/.config/sops/age/keys.txt\`"
  echo "             Or set SOPS_AGE_KEY_FILE."
  exit 1
fi

tmp="$(mktemp)"
trap "rm -f '$tmp'" EXIT

sops --decrypt --input-type=dotenv --output-type=dotenv .env.local.sops > "$tmp"

if [ -f .env.local ]; then
  if diff -q <(grep -v "^$" .env.local) <(grep -v "^$" "$tmp") > /dev/null; then
    echo "[env-decrypt] ✓ .env.local already matches encrypted source. No change."
    exit 0
  fi
  echo "[env-decrypt] ⚠️  .env.local differs from .env.local.sops."
  echo "              If you edited .env.local locally and want to keep your"
  echo "              changes, run \`npm run env:encrypt\` first."
  echo "              If you want to discard local changes and pull from"
  echo "              the encrypted source, run:"
  echo "                  rm .env.local && npm run env:decrypt"
  exit 1
fi

mv "$tmp" .env.local
chmod 600 .env.local
trap - EXIT
echo "[env-decrypt] ✓ Wrote .env.local (mode 600)."
