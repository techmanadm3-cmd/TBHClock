#!/bin/sh
set -eu
MODE="${1:-status}"
ROOT=/opt/tbhclock
SHARED="$ROOT/shared"
ENVFILE="$SHARED/.env"
CRED="$SHARED/secrets/google-service-account.json"

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
