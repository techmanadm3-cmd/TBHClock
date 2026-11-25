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
ACTIVE_COLOR_FILE="$ROOT/ACTIVE_COLOR"
ACTIVE_PORT_FILE="$ROOT/ACTIVE_PORT"
PREVIOUS=""

mkdir -p "$RELEASES" "$SHARED/secrets" "$SHARED/uploads/clock-images"

if [ ! -d "$REPO/.git" ]; then
  rm -rf "$REPO"
  git clone https://github.com/techmanadm3-cmd/TBHClock.git "$REPO"
fi

git -C "$REPO" fetch --prune origin main
git -C "$REPO" cat-file -e "$sha^{commit}"

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

  cat > /etc/sudoers.d/tbhclock-github <<'EOF'
tbhclock-github ALL=(root) NOPASSWD: /usr/local/sbin/tbhclock-deploy *
tbhclock-github ALL=(root) NOPASSWD: /usr/local/sbin/tbhclock-runtime-bootstrap
tbhclock-github ALL=(root) NOPASSWD: /usr/local/sbin/tbhclock-runtime-check
EOF
  chmod 440 /etc/sudoers.d/tbhclock-github
  visudo -cf /etc/sudoers.d/tbhclock-github >/dev/null

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
ln -sfn "$SHARED/uploads" "$RELEASE/uploads"

BASE_PORT=$(sed -n 's/^TBHCLOCK_HOST_PORT=//p' "$SHARED/.env" | tail -n 1)
BASE_PORT=${BASE_PORT:-18180}
case "$BASE_PORT" in *[!0-9]*|'') echo "INVALID_HOST_PORT" >&2; exit 74 ;; esac
[ "$BASE_PORT" -lt 65535 ] || { echo "INVALID_HOST_PORT" >&2; exit 74; }
ALT_PORT=$((BASE_PORT + 1))

if [ -f "$ACTIVE_COLOR_FILE" ] && [ -f "$ACTIVE_PORT_FILE" ]; then
  OLD_COLOR=$(cat "$ACTIVE_COLOR_FILE" || true)
  OLD_PORT=$(cat "$ACTIVE_PORT_FILE" || true)
  case "$OLD_COLOR" in
    blue) NEW_COLOR=green; NEW_PORT="$ALT_PORT" ;;
    green) NEW_COLOR=blue; NEW_PORT="$BASE_PORT" ;;
    *) echo "INVALID_ACTIVE_COLOR" >&2; exit 75 ;;
  esac
  OLD_PROJECT="tbhclock_$OLD_COLOR"
else
  # Legacy single-container deployment on BASE_PORT.
  OLD_COLOR=legacy
  OLD_PORT="$BASE_PORT"
  OLD_PROJECT=tbhclock
  NEW_COLOR=green
  NEW_PORT="$ALT_PORT"
fi

case "$OLD_PORT" in *[!0-9]*|'') echo "INVALID_ACTIVE_PORT" >&2; exit 76 ;; esac
NEW_PROJECT="tbhclock_$NEW_COLOR"
NEW_COMPOSE="$RELEASE/.tbhclock-compose.yml"

# Remove the legacy fixed container_name so blue and green can coexist.
sed '/^[[:space:]]*container_name:[[:space:]]*/d' "$RELEASE/docker-compose.yml" > "$NEW_COMPOSE"

echo "DEPLOY_STRATEGY=BLUE_GREEN"
echo "DEPLOY_OLD_COLOR=$OLD_COLOR"
echo "DEPLOY_OLD_PORT=$OLD_PORT"
echo "DEPLOY_NEW_COLOR=$NEW_COLOR"
echo "DEPLOY_NEW_PORT=$NEW_PORT"

cd "$RELEASE"
TBHCLOCK_HOST_PORT="$NEW_PORT" docker compose -f "$NEW_COMPOSE" -p "$NEW_PROJECT" --env-file "$SHARED/.env" up -d --build --remove-orphans

ok=0
i=0
while [ "$i" -lt 30 ]; do
  body=$(curl -fsS "http://127.0.0.1:$NEW_PORT/api/health?deep=1" 2>/dev/null || true)
  if printf '%s' "$body" | grep -q '"googleSheets":true'; then
    ok=1
    break
  fi
  i=$((i+1))
  sleep 2
done

if [ "$ok" -ne 1 ]; then
  echo "DEPLOY_CANDIDATE_HEALTH=FAIL" >&2
  TBHCLOCK_HOST_PORT="$NEW_PORT" docker compose -f "$NEW_COMPOSE" -p "$NEW_PROJECT" --env-file "$SHARED/.env" down --timeout 10 --remove-orphans || true
  exit 73
fi

echo "DEPLOY_CANDIDATE_HEALTH=PASS"

# Switch nginx only after the candidate is fully healthy.
if ! /usr/local/sbin/tbhclock-public-apply "$NEW_PORT"; then
  echo "DEPLOY_INGRESS_SWITCH=FAIL" >&2
  /usr/local/sbin/tbhclock-public-apply "$OLD_PORT" || true
  TBHCLOCK_HOST_PORT="$NEW_PORT" docker compose -f "$NEW_COMPOSE" -p "$NEW_PROJECT" --env-file "$SHARED/.env" down --timeout 10 --remove-orphans || true
  exit 77
fi

printf '%s\n' "$sha" > "$ACTIVE_FILE"
printf '%s\n' "$NEW_COLOR" > "$ACTIVE_COLOR_FILE"
printf '%s\n' "$NEW_PORT" > "$ACTIVE_PORT_FILE"
ln -sfn "$RELEASE" "$ROOT/current"

echo "DEPLOY_INGRESS_SWITCH=PASS"
echo "DEPLOY_SHA=$sha"
echo "DEPLOY_COLOR=$NEW_COLOR"
echo "DEPLOY_PORT=$NEW_PORT"
echo "DEPLOY_HEALTH=PASS"

# The public site is already on the new healthy container. Retire the old one
# only after the switch, so a slow stop can never create public downtime.
if [ "$OLD_COLOR" = "legacy" ]; then
  if [ -n "$PREVIOUS" ] && [ -f "$RELEASES/$PREVIOUS/docker-compose.yml" ]; then
    cd "$RELEASES/$PREVIOUS"
    TBHCLOCK_HOST_PORT="$OLD_PORT" docker compose -p tbhclock --env-file "$SHARED/.env" down --timeout 10 --remove-orphans || true
  else
    docker rm -f tbh-hr-web >/dev/null 2>&1 || true
  fi
else
  OLD_RELEASE="$RELEASES/$PREVIOUS"
  if [ -n "$PREVIOUS" ] && [ -d "$OLD_RELEASE" ]; then
    OLD_COMPOSE="$OLD_RELEASE/.tbhclock-compose.yml"
    if [ ! -f "$OLD_COMPOSE" ]; then
      sed '/^[[:space:]]*container_name:[[:space:]]*/d' "$OLD_RELEASE/docker-compose.yml" > "$OLD_COMPOSE"
    fi
    cd "$OLD_RELEASE"
    TBHCLOCK_HOST_PORT="$OLD_PORT" docker compose -f "$OLD_COMPOSE" -p "$OLD_PROJECT" --env-file "$SHARED/.env" down --timeout 10 --remove-orphans || true
  fi
fi

echo "DEPLOY_OLD_RELEASE_RETIRED=PASS"
