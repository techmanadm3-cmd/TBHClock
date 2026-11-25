#!/bin/sh
set -eu
ROOT=/opt/tbhclock
ENVFILE="$ROOT/shared/.env"
ACTIVE_PORT_FILE="$ROOT/ACTIVE_PORT"
SITE_AVAIL=/etc/nginx/sites-available/tbhclock
SITE_ENABLED=/etc/nginx/sites-enabled/tbhclock

[ -f "$ENVFILE" ] || { echo "RUNTIME_ENV=MISSING" >&2; exit 71; }
DOMAIN=$(sed -n 's/^TBHCLOCK_PUBLIC_DOMAIN=//p' "$ENVFILE" | tail -n 1)
PORT="${1:-}"
if [ -z "$PORT" ] && [ -f "$ACTIVE_PORT_FILE" ]; then PORT=$(cat "$ACTIVE_PORT_FILE" || true); fi
if [ -z "$PORT" ]; then PORT=$(sed -n 's/^TBHCLOCK_HOST_PORT=//p' "$ENVFILE" | tail -n 1); fi
PORT=${PORT:-18180}
case "$PORT" in *[!0-9]*|'') echo "PUBLIC_PORT=INVALID" >&2; exit 72 ;; esac
PUBLIC_IP=$(sed -n 's/^TBHCLOCK_PUBLIC_IP=//p' "$ENVFILE" | tail -n 1)
PUBLIC_IP=${PUBLIC_IP:-218.208.91.225}

[ -n "$DOMAIN" ] || { echo "PUBLIC_DOMAIN=HOLD"; echo "PUBLIC_HTTPS=HOLD"; exit 0; }
case "$DOMAIN" in
  *[!A-Za-z0-9.-]*|.*|*..*|*.) echo "PUBLIC_DOMAIN=INVALID" >&2; exit 73 ;;
esac

command -v nginx >/dev/null 2>&1 || { echo "NGINX=MISSING" >&2; exit 74; }
command -v certbot >/dev/null 2>&1 || { echo "CERTBOT=MISSING" >&2; exit 75; }

resolved_ok=0
i=0
while [ "$i" -lt 20 ]; do
  resolved=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u || true)
  if printf '%s\n' "$resolved" | grep -Fx "$PUBLIC_IP" >/dev/null 2>&1; then
    resolved_ok=1
    break
  fi
  i=$((i+1))
  sleep 2
done

if [ "$resolved_ok" -ne 1 ]; then
  echo "PUBLIC_DOMAIN=$DOMAIN"
  echo "PUBLIC_DNS=HOLD_EXPECTED_$PUBLIC_IP"
  echo "PUBLIC_HTTPS=HOLD"
  exit 0
fi

CERT_FULLCHAIN="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
CERT_PRIVKEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"

if [ -s "$CERT_FULLCHAIN" ] && [ -s "$CERT_PRIVKEY" ] && [ -f "$SITE_AVAIL" ] && grep -q 'listen 443' "$SITE_AVAIL"; then
  sed -i -E "s#proxy_pass http://127\.0\.0\.1:[0-9]+;#proxy_pass http://127.0.0.1:$PORT;#g" "$SITE_AVAIL"
  ln -sfn "$SITE_AVAIL" "$SITE_ENABLED"
  nginx -t
  systemctl reload nginx
  echo "PUBLIC_CERTIFICATE=EXISTING"
else
  cat > "$SITE_AVAIL" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
EOF
  ln -sfn "$SITE_AVAIL" "$SITE_ENABLED"
  nginx -t
  systemctl reload nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --register-unsafely-without-email
  nginx -t
  systemctl reload nginx
  echo "PUBLIC_CERTIFICATE=ISSUED"
fi

body=$(curl -fsS --max-time 15 "https://$DOMAIN/api/health?deep=1" 2>/dev/null || true)
printf '%s' "$body" | grep -q '"googleSheets":true' || {
  echo "PUBLIC_HTTPS_HEALTH=FAIL" >&2
  exit 77
}

echo "PUBLIC_DOMAIN=$DOMAIN"
echo "PUBLIC_PORT=$PORT"
echo "PUBLIC_DNS=READY"
echo "PUBLIC_HTTPS=READY"
echo "PUBLIC_HTTPS_HEALTH=PASS"
