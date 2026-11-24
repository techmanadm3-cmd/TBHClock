#!/bin/sh
set -eu
ROOT=/opt/tbhclock
SHARED="$ROOT/shared"
ENVFILE="$SHARED/.env"
CRED="$SHARED/secrets/google-service-account.json"

[ -f "$ENVFILE" ] || { echo "RUNTIME_ENV=HOLD"; exit 81; }
echo "RUNTIME_ENV=READY"

if [ ! -f "$CRED" ]; then
  echo "GOOGLE_CREDENTIAL=HOLD"
  exit 82
fi

mode=$(stat -c '%a' "$CRED")
case "$mode" in
  600|400) ;;
  *) chmod 600 "$CRED" ;;
esac

if grep -q '"type"[[:space:]]*:[[:space:]]*"service_account"' "$CRED"; then
  echo "GOOGLE_CREDENTIAL_TYPE=SERVICE_ACCOUNT"
else
  echo "GOOGLE_CREDENTIAL_TYPE=UNKNOWN"
  exit 83
fi
echo "GOOGLE_CREDENTIAL=READY"
echo "RUNTIME_CONFIG=READY"
