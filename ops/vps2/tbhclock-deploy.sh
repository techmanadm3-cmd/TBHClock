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

if [ ! -d "$REPO/.git" ]; then
  rm -rf "$REPO"
  git clone https://github.com/techmanadm3-cmd/TBHClock.git "$REPO"
fi

git -C "$REPO" fetch --prune origin main
git -C "$REPO" cat-file -e "$sha^{commit}"

# Refresh the VPS deploy engine from the exact commit being deployed, then
# re-exec once so deploy logic and application source always stay in sync.
if [ "${TBHCLOCK_DEPLOY_SELF_UPDATED:-0}" != "1" ]; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT HUP INT TERM
  for name in tbhclock-deploy.sh tbhclock-gateway.sh tbhclock-runtime-bootstrap.sh tbhclock-runtime-check.sh tbhclock-public-check.sh tbhclock-public-apply.sh; do
    git -C "$REPO" show "$sha:ops/vps2/$name" > "$TMP/$name"
    chmod 755 "$TMP/$name"
  done
  install -m 755 "$TMP/tbhclock-deploy.sh" /usr/local/sbin/tbhclock-deploy
  install -m 755 "$TMP/tbhclock-gateway.sh" /usr/local/sbin/tbhclock-gateway
  install -m 755 "$TMP/tbhclock-runtime-bootstrap.sh" /usr/local/sbin/tbhclock-runtime-bootstrap
  install -m 755 "$TMP/tbhclock-runtime-check.sh" /usr/local/sbin/tbhclock-runtime-check
  install -m 755 "$TMP/tbhclock-public-check.sh" /usr/local/sbin/tbhclock-public-check
  install -m 755 "$TMP/tbhclock-public-apply.sh" /usr/local/sbin/tbhclock-public-apply
  rm -rf "$TMP"
  trap - EXIT HUP INT TERM
  TBHCLOCK_DEPLOY_SELF_UPDATED=1 exec /usr/local/sbin/tbhclock-deploy "$sha"
fi

/usr/local/sbin/tbhclock-runtime-bootstrap
/usr/local/sbin/tbhclock-runtime-check

if [ -f "$ACTIVE_FILE" ]; then PREVIOUS=$(cat "$ACTIVE_FILE" || true); fi

rm -rf "$RELEASE"
mkdir -p "$RELEASE"
git -C "$REPO" archive "$sha" | tar -x -C "$RELEASE"

ln -sfn "$SHARED/.env" "$RELEASE/.env"
ln -sfn "$SHARED/secrets" "$RELEASE/secrets"

HOST_PORT=$(sed -n 's/^TBHCLOCK_HOST_PORT=//p' "$SHARED/.env" | tail -n 1)
HOST_PORT=${HOST_PORT:-18180}
case "$HOST_PORT" in *[!0-9]*|'') echo "INVALID_HOST_PORT" >&2; exit 74 ;; esac

cd "$RELEASE"
docker compose -p tbhclock --env-file "$SHARED/.env" up -d --build --remove-orphans

ok=0
i=0
while [ "$i" -lt 20 ]; do
  body=$(curl -fsS "http://127.0.0.1:$HOST_PORT/api/health?deep=1" 2>/dev/null || true)
  if printf '%s' "$body" | grep -q '"googleSheets":true'; then
    ok=1
    break
  fi
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
echo "DEPLOY_PORT=$HOST_PORT"
echo "DEPLOY_HEALTH=PASS"
