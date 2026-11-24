#!/bin/sh
set -eu
ROOT=/opt/tbhclock
ENVFILE="$ROOT/shared/.env"
SITE_AVAIL=/etc/nginx/sites-available/tbhclock
SITE_ENABLED=/etc/nginx/sites-enabled/tbhclock

[ -f "$ENVFILE" ] || { echo "RUNTIME_ENV=MISSING" >&2; exit 71; }
DOMAIN=$(sed -n 's/^TBHCLOCK_PUBLIC_DOMAIN=//p' "$ENVFILE" | tail -n 1)
PORT=$(sed -n 's/^TBHCLOCK_HOST_PORT=//p' "$ENVFILE" | tail -n 1)
PORT=${PORT:-18180}
PUBLIC_IP=$(sed -n 's/^TBHCLOCK_PUBLIC_IP=//p' "$ENVFILE" | tail -n 1)
PUBLIC_IP=${PUBLIC_IP:-218.208.91.225}

[ -n "$DOMAIN" ] || { echo "PUBLIC_DOMAIN=HOLD" >&2; exit 72; }
case "$DOMAIN" in
  *[!A-Za-z0-9.-]*|.*|*..*|*.) echo "PUBLIC_DOMAIN=INVALID" >&2; exit 73 ;;
esac

command -v nginx >/dev/null 2>&1 || { echo "NGINX=MISSING" >&2; exit 74; }
command -v certbot >/dev/null 2>&1 || { echo "CERTBOT=MISSING" >&2; exit 75; }

resolved=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u || true)
printf '%s\n' "$resolved" | grep -Fx "$PUBLIC_IP" >/dev/null 2>&1 || {
  echo "PUBLIC_DNS=HOLD_EXPECTED_$PUBLIC_IP" >&2
  exit 76
}

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

echo "PUBLIC_DOMAIN=$DOMAIN"
echo "PUBLIC_HTTPS=READY"
