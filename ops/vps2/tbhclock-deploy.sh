#!/bin/sh
set -eu
sha="${1:-}"
case "$sha" in *[!0-9a-f]*|'') exit 64 ;; esac
[ "${#sha}" -eq 40 ] || exit 64

ROOT=/opt/tbhclock
REPO="$ROOT/repo"
RELEASES="$ROOT/releases"
SHARED="$ROOT/shared"
RELEASE="$RELEASES/$sha"
ACTIVE_FILE="$ROOT/ACTIVE_SHA"
PREVIOUS=""

mkdir -p "$RELEASES" "$SHARED/secrets"
if [ -f "$ACTIVE_FILE" ]; then PREVIOUS=$(cat "$ACTIVE_FILE" || true); fi

if [ ! -d "$REPO/.git" ]; then
  rm -rf "$REPO"
  git clone https://github.com/techmanadm3-cmd/TBHClock.git "$REPO"
fi

git -C "$REPO" fetch --prune origin main
git -C "$REPO" cat-file -e "$sha^{commit}"

rm -rf "$RELEASE"
mkdir -p "$RELEASE"
git -C "$REPO" archive "$sha" | tar -x -C "$RELEASE"

[ -f "$SHARED/.env" ] || { echo "HOLD: $SHARED/.env missing" >&2; exit 71; }
[ -f "$SHARED/secrets/google-service-account.json" ] || { echo "HOLD: Google service account JSON missing" >&2; exit 72; }

ln -sfn "$SHARED/.env" "$RELEASE/.env"
ln -sfn "$SHARED/secrets" "$RELEASE/secrets"

cd "$RELEASE"
docker compose -p tbhclock --env-file "$SHARED/.env" up -d --build --remove-orphans

ok=0
i=0
while [ "$i" -lt 20 ]; do
  if curl -fsS http://127.0.0.1:18080/api/health >/dev/null 2>&1; then ok=1; break; fi
  i=$((i+1))
  sleep 2
done

if [ "$ok" -ne 1 ]; then
  echo "DEPLOY_HEALTH=FAIL" >&2
  if [ -n "$PREVIOUS" ] && [ -d "$RELEASES/$PREVIOUS" ]; then
    cd "$RELEASES/$PREVIOUS"
    docker compose -p tbhclock --env-file "$SHARED/.env" up -d --build --remove-orphans || true
  fi
  exit 73
fi

printf '%s\n' "$sha" > "$ACTIVE_FILE"
ln -sfn "$RELEASE" "$ROOT/current"
echo "DEPLOY_SHA=$sha"
echo "DEPLOY_HEALTH=PASS"
