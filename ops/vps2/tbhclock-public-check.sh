#!/bin/sh
set -eu
ROOT=/opt/tbhclock
ENVFILE="$ROOT/shared/.env"
PORT=18180
DOMAIN=""

if [ -f "$ENVFILE" ]; then
  p=$(sed -n 's/^TBHCLOCK_HOST_PORT=//p' "$ENVFILE" | tail -n 1)
  [ -n "$p" ] && PORT="$p"
  DOMAIN=$(sed -n 's/^TBHCLOCK_PUBLIC_DOMAIN=//p' "$ENVFILE" | tail -n 1)
fi

if command -v nginx >/dev/null 2>&1; then echo "NGINX=READY"; else echo "NGINX=MISSING"; fi
if command -v certbot >/dev/null 2>&1; then echo "CERTBOT=READY"; else echo "CERTBOT=MISSING"; fi

body=$(curl -fsS "http://127.0.0.1:$PORT/api/health?deep=1" 2>/dev/null || true)
if printf '%s' "$body" | grep -q '"googleSheets":true'; then
  echo "APP_DEEP_HEALTH=PASS"
else
  echo "APP_DEEP_HEALTH=FAIL"
  exit 71
fi

if [ -z "$DOMAIN" ]; then
  echo "PUBLIC_DOMAIN=HOLD"
  echo "PUBLIC_INGRESS=HOLD_DOMAIN"
  exit 0
fi

case "$DOMAIN" in
  *[!A-Za-z0-9.-]*|.*|*..*|*.) echo "PUBLIC_DOMAIN=INVALID"; exit 72 ;;
esac

echo "PUBLIC_DOMAIN=$DOMAIN"
if getent ahostsv4 "$DOMAIN" >/dev/null 2>&1; then
  echo "PUBLIC_DNS=RESOLVES"
else
  echo "PUBLIC_DNS=HOLD"
fi

if [ -L "/etc/nginx/sites-enabled/tbhclock" ] || [ -f "/etc/nginx/conf.d/tbhclock.conf" ]; then
  echo "NGINX_SITE=READY"
else
  echo "NGINX_SITE=HOLD"
fi
