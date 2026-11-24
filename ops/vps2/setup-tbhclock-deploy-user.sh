#!/bin/sh
set -eu
PUBKEY="${1:-}"
[ -n "$PUBKEY" ] || { echo "Usage: sudo sh setup-tbhclock-deploy-user.sh '<public-key>'" >&2; exit 2; }

id tbhclock-github >/dev/null 2>&1 || useradd --create-home --shell /bin/sh tbhclock-github
install -d -m 700 -o tbhclock-github -g tbhclock-github /home/tbhclock-github/.ssh
printf 'command="/usr/local/sbin/tbhclock-gateway",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding %s\n' "$PUBKEY" > /home/tbhclock-github/.ssh/authorized_keys
chown tbhclock-github:tbhclock-github /home/tbhclock-github/.ssh/authorized_keys
chmod 600 /home/tbhclock-github/.ssh/authorized_keys

install -m 755 ops/vps2/tbhclock-gateway.sh /usr/local/sbin/tbhclock-gateway
install -m 755 ops/vps2/tbhclock-deploy.sh /usr/local/sbin/tbhclock-deploy
install -m 755 ops/vps2/tbhclock-runtime-bootstrap.sh /usr/local/sbin/tbhclock-runtime-bootstrap
install -m 755 ops/vps2/tbhclock-runtime-check.sh /usr/local/sbin/tbhclock-runtime-check
install -m 755 ops/vps2/tbhclock-public-check.sh /usr/local/sbin/tbhclock-public-check
install -m 755 ops/vps2/tbhclock-public-apply.sh /usr/local/sbin/tbhclock-public-apply

cat > /etc/sudoers.d/tbhclock-github <<'EOF'
tbhclock-github ALL=(root) NOPASSWD: /usr/local/sbin/tbhclock-deploy *
tbhclock-github ALL=(root) NOPASSWD: /usr/local/sbin/tbhclock-runtime-bootstrap
tbhclock-github ALL=(root) NOPASSWD: /usr/local/sbin/tbhclock-runtime-check
tbhclock-github ALL=(root) NOPASSWD: /usr/local/sbin/tbhclock-public-check
tbhclock-github ALL=(root) NOPASSWD: /usr/local/sbin/tbhclock-public-apply
EOF
chmod 440 /etc/sudoers.d/tbhclock-github
visudo -cf /etc/sudoers.d/tbhclock-github

mkdir -p /opt/tbhclock/shared/secrets /opt/tbhclock/releases
chmod 755 /opt/tbhclock
echo "TBHCLOCK_DEPLOY_USER=READY"
