#!/bin/sh
set -eu
cmd="${SSH_ORIGINAL_COMMAND:-}"
case "$cmd" in
  ping)
    printf '%s\n' '{"result":"PASS","service":"tbhclock-gateway","deploy":"ENABLED"}'
    ;;
  bootstrap)
    exec sudo -n /usr/local/sbin/tbhclock-runtime-bootstrap
    ;;
  runtime-check)
    exec sudo -n /usr/local/sbin/tbhclock-runtime-check
    ;;
  "deploy "*)
    sha=${cmd#deploy }
    case "$sha" in
      *[!0-9a-f]*|'') printf '%s\n' '{"result":"DENIED","reason":"INVALID_SHA"}'; exit 64 ;;
    esac
    [ "${#sha}" -eq 40 ] || { printf '%s\n' '{"result":"DENIED","reason":"INVALID_SHA"}'; exit 64; }
    exec sudo -n /usr/local/sbin/tbhclock-deploy "$sha"
    ;;
  *)
    printf '%s\n' '{"result":"DENIED","reason":"COMMAND_NOT_ALLOWED"}'
    exit 64
    ;;
esac
