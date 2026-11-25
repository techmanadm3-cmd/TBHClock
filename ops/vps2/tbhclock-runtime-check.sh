#!/bin/sh
set -eu
MODE="${1:-status}"
ROOT=/opt/tbhclock
SHARED="$ROOT/shared"
ENVFILE="$SHARED/.env"
CRED="$SHARED/secrets/google-service-account.json"
ACTIVE_PORT_FILE="$ROOT/ACTIVE_PORT"

hold() {
  echo "$1"
  echo "RUNTIME_CONFIG=HOLD"
  if [ "$MODE" = "--ready" ]; then exit 82; fi
  exit 0
}

[ -f "$ENVFILE" ] || hold "RUNTIME_ENV=HOLD"
echo "RUNTIME_ENV=READY"

[ -f "$CRED" ] || {
  echo "GOOGLE_CREDENTIAL=HOLD"
  echo "RUNTIME_CONFIG=HOLD"
  if [ "$MODE" = "--ready" ]; then exit 82; fi
  exit 0
}

mode=$(stat -c '%a' "$CRED")
case "$mode" in
  600|400) ;;
  *) chmod 600 "$CRED" ;;
esac

if grep -q '"type"[[:space:]]*:[[:space:]]*"service_account"' "$CRED"; then
  echo "GOOGLE_CREDENTIAL_TYPE=SERVICE_ACCOUNT"
else
  echo "GOOGLE_CREDENTIAL_TYPE=UNKNOWN"
  echo "RUNTIME_CONFIG=HOLD"
  if [ "$MODE" = "--ready" ]; then exit 83; fi
  exit 0
fi

echo "GOOGLE_CREDENTIAL=READY"
echo "RUNTIME_CONFIG=READY"

HOST_PORT=""
if [ -f "$ACTIVE_PORT_FILE" ]; then HOST_PORT=$(cat "$ACTIVE_PORT_FILE" || true); fi
if [ -z "$HOST_PORT" ]; then HOST_PORT=$(sed -n 's/^TBHCLOCK_HOST_PORT=//p' "$ENVFILE" | tail -n 1); fi
HOST_PORT=${HOST_PORT:-18180}
PUBLIC_DOMAIN=$(sed -n 's/^TBHCLOCK_PUBLIC_DOMAIN=//p' "$ENVFILE" | tail -n 1)

if command -v nginx >/dev/null 2>&1; then echo "NGINX=READY"; else echo "NGINX=MISSING"; fi
if command -v certbot >/dev/null 2>&1; then echo "CERTBOT=READY"; else echo "CERTBOT=MISSING"; fi

body=$(curl -fsS "http://127.0.0.1:$HOST_PORT/api/health?deep=1" 2>/dev/null || true)
if printf '%s' "$body" | grep -q '"googleSheets":true'; then
  echo "APP_DEEP_HEALTH=PASS"
else
  echo "APP_DEEP_HEALTH=HOLD"
fi
echo "APP_ACTIVE_PORT=$HOST_PORT"

if [ -z "$PUBLIC_DOMAIN" ]; then
  echo "PUBLIC_DOMAIN=HOLD"
  echo "PUBLIC_INGRESS=HOLD_DOMAIN"
else
  echo "PUBLIC_DOMAIN=$PUBLIC_DOMAIN"
  if getent ahostsv4 "$PUBLIC_DOMAIN" >/dev/null 2>&1; then echo "PUBLIC_DNS=RESOLVES"; else echo "PUBLIC_DNS=HOLD"; fi
  if [ -L /etc/nginx/sites-enabled/tbhclock ] || [ -f /etc/nginx/conf.d/tbhclock.conf ]; then echo "NGINX_SITE=READY"; else echo "NGINX_SITE=HOLD"; fi
fi
