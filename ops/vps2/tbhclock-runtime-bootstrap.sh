#!/bin/sh
set -eu
ROOT=/opt/tbhclock
SHARED="$ROOT/shared"
SECRETS="$SHARED/secrets"
ENVFILE="$SHARED/.env"
mkdir -p "$SECRETS" "$ROOT/releases"

if [ ! -f "$ENVFILE" ]; then
  umask 077
  APP_SECRET=$(openssl rand -hex 48)
  cat > "$ENVFILE" <<EOF
PORT=8080
APP_SECRET=$APP_SECRET
GOOGLE_SPREADSHEET_ID=1VY4ZK4Upd6XBT-gdXxfd2ZbgfAlr5MdveDVoIeAGhTI
APP_TIMEZONE=Asia/Kuala_Lumpur
CLOCK_CACHE_SECONDS=120
TBHCLOCK_HOST_PORT=18180
TBHCLOCK_PUBLIC_DOMAIN=tbhhr.techman.my
TBHCLOCK_PUBLIC_IP=218.208.91.225
EOF
else
  grep -q '^TBHCLOCK_HOST_PORT=' "$ENVFILE" || printf '%s\n' 'TBHCLOCK_HOST_PORT=18180' >> "$ENVFILE"
  grep -q '^TBHCLOCK_PUBLIC_DOMAIN=' "$ENVFILE" || printf '%s\n' 'TBHCLOCK_PUBLIC_DOMAIN=tbhhr.techman.my' >> "$ENVFILE"
  grep -q '^TBHCLOCK_PUBLIC_IP=' "$ENVFILE" || printf '%s\n' 'TBHCLOCK_PUBLIC_IP=218.208.91.225' >> "$ENVFILE"
fi

chmod 600 "$ENVFILE"
chmod 700 "$SECRETS"

command -v docker >/dev/null 2>&1 || { echo "RUNTIME_DOCKER=MISSING"; exit 71; }
docker compose version >/dev/null 2>&1 || { echo "RUNTIME_DOCKER_COMPOSE=MISSING"; exit 72; }

echo "RUNTIME_ENV=READY"
if [ -f "$SECRETS/google-service-account.json" ]; then
  chmod 600 "$SECRETS/google-service-account.json"
  echo "GOOGLE_CREDENTIAL=READY"
else
  echo "GOOGLE_CREDENTIAL=HOLD"
fi
