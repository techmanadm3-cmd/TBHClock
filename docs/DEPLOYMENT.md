# VPS2 deployment contract

This project uses a dedicated Windows self-hosted runner and a dedicated VPS2 SSH identity.

Runner-local files (never commit these):
- C:\ProgramData\TBHClock-SSH\id_ed25519
- C:\ProgramData\TBHClock-SSH\id_ed25519.pub
- C:\ProgramData\TBHClock-SSH\known_hosts
- C:\ProgramData\TBHClock-SSH\deploy.env

Expected deploy.env keys:
- TBHCLOCK_SSH_HOST=<VPS2 host>
- TBHCLOCK_SSH_PORT=<SSH port>
- TBHCLOCK_SSH_USER=<dedicated TBHClock deploy user>

The remote account should be dedicated to TBHClock and expose only a bounded deployment gateway:
- accept uploaded release archives under incoming/
- accept deploy <40-char SHA>
- unpack to a versioned release directory
- preserve server-side .env and secrets/google-service-account.json
- run Docker Compose
- perform localhost health check
- record the active SHA only after health passes
- reject arbitrary shell commands

Deployment workflow remains manual-only until this SSH boundary is installed and verified.
