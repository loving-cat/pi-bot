#!/usr/bin/env bash
# Regression for scripts/check-secrets.mjs --push: builds throwaway repos and checks
# that personal addresses / hostnames in commit metadata are caught, and that
# automation identities and noreply addresses pass.
#   bash scripts/tests/check-secrets-push-test.sh
set -u
here="$(cd "$(dirname "$0")/../.." && pwd)"
script="$here/scripts/check-secrets.mjs"
fail=0
zero=0000000000000000000000000000000000000000

new_repo() {
  local d
  d="$(mktemp -d "${TMPDIR:-/tmp}/cs-push-XXXXXX")"
  git -C "$d" init -q
  printf '%s' "$d"
}
commit() { # dir email message
  git -C "$1" -c user.name=probe -c user.email="$2" -c commit.gpgsign=false commit -q --allow-empty -m "$3"
}
# Probe addresses are assembled at runtime so this file itself never contains a
# literal that the tracked-file scan would (rightly) flag.
at='@'
mac_host="someone${at}Some-MacBook-Pro.lo""cal"
qq_mail="12345678${at}q""q.com"
real_mail="someone${at}mail-provider.net"
cursor_mail="cursoragent${at}cursor.com"
expect() { # name expected-exit dir before after
  local name="$1" want="$2" dir="$3" out code
  out="$(cd "$dir" && node "$script" --push "$4" "$5" 2>&1)"
  code=$?
  if [ "$code" = "$want" ]; then
    echo "  ok   $name"
  else
    echo "  FAIL $name (exit $code, want $want)"
    printf '%s\n' "$out" | sed -E 's/[A-Za-z0-9._%+-]+@/*@/g' | head -8
    fail=1
  fi
}

d="$(new_repo)"
commit "$d" 1+someone@users.noreply.github.com "clean"
commit "$d" codex@localhost "automation"
commit "$d" "$cursor_mail" "cursor"$'\n\n'"Co-authored-by: Cursor Agent <$cursor_mail>"
expect "noreply + automation identities pass (whole history)" 0 "$d" "$zero" HEAD
base="$(git -C "$d" rev-parse HEAD)"

commit "$d" "$mac_host" "mac default identity"
expect "hostname author is caught" 1 "$d" "$base" HEAD
expect "unknown 'before' (force push) falls back to whole history" 1 "$d" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" HEAD

d2="$(new_repo)"
commit "$d2" 1+someone@users.noreply.github.com "clean"
b2="$(git -C "$d2" rev-parse HEAD)"
commit "$d2" "$qq_mail" "qq author"
expect "qq author is caught" 1 "$d2" "$b2" HEAD

d3="$(new_repo)"
commit "$d3" 1+someone@users.noreply.github.com "clean"
b3="$(git -C "$d3" rev-parse HEAD)"
commit "$d3" 1+someone@users.noreply.github.com "msg"$'\n\n'"Co-authored-by: Someone <$real_mail>"
expect "real address in message trailer is caught" 1 "$d3" "$b3" HEAD
commit "$d3" 1+someone@users.noreply.github.com "later clean"
b4="$(git -C "$d3" rev-parse HEAD)"
expect "known 'before' only scans the new range" 0 "$d3" "$b4" HEAD

rm -rf "$d" "$d2" "$d3"
if [ "$fail" = 0 ]; then echo "check-secrets --push: all passed"; else echo "check-secrets --push: FAILED"; fi
exit "$fail"
