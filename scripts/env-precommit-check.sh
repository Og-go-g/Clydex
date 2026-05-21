#!/usr/bin/env bash
# Pre-commit safety net for secrets.
#
# Runs before every commit. Refuses if any plaintext .env file is
# staged, or if a *.sops file is staged AND contains values that
# don't look encrypted (suggesting someone copy-pasted plaintext
# into a .sops file by mistake).
#
# Two failure modes to catch:
#   1. Plaintext .env.* accidentally added (most common — git add -A
#      grabs everything). The .gitignore already shields these but
#      `git add -f` bypasses it; this hook re-checks.
#   2. A .sops file that lacks the sops metadata footer (e.g. you
#      hand-edited it and broke the encryption envelope).
#
# Exit code: 0 if all is well, non-zero if a problem is found.

set -euo pipefail

# Lines added in this commit. We grep what's staged, not the working
# tree, so a contributor with a dirty .env.local doesn't get blocked
# every time they commit unrelated work.
staged=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || echo "")

fail=0

# Check 1: plaintext .env files staged. The .gitignore should catch
# these but `git add -f` bypasses it.
for f in $staged; do
  case "$f" in
    .env|.env.local|.env.production|.env.development|.env.staging|.env.test|.env.*.local)
      echo "[env-check] ❌ Plaintext env file staged: $f"
      echo "            Use \`npm run env:encrypt\` and commit \`$f.sops\` instead."
      fail=1
      ;;
  esac
done

# Check 2: .sops files staged but missing the sops envelope footer.
# A correctly-encrypted sops dotenv ends with `sops_version=...`.
for f in $staged; do
  case "$f" in
    *.sops)
      if [ -f "$f" ] && ! grep -q "^sops_version=" "$f"; then
        echo "[env-check] ❌ $f is missing the sops envelope footer."
        echo "            Did you hand-edit it? Re-encrypt via \`npm run env:encrypt\`."
        fail=1
      fi
      ;;
  esac
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Commit aborted. Fix the issues above and re-stage."
  exit 1
fi

exit 0
