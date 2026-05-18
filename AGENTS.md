# Octopus Agent Notes

`octopus` is a Bun-based process manager for long-running local services.

## What matters

- Main code: `src/index.js`
- Managed apps: `config/apps.json`
- systemd unit: `systemd/octopus.service`
- Installer: `scripts/install-service.sh`

## How to run

- Interactive TUI: `cd /root/octopus && bun run start`
- Install/update the service: `cd /root/octopus && bun run install-service`
- Start/restart on host: `systemctl start octopus.service` / `systemctl restart octopus.service`
- Logs: `journalctl -u octopus.service -n 200 --no-pager`

## Current local conventions

- App definitions may use `envFile` for secrets-loaded processes.
- `web-proxy` listens on host port `80`.
- `auto-x-web` runs on host port `3000`.
- `auto-x-stream` is still defined here on host port `8787`, but live websocket traffic for `alpha.robolike.com/ws` is currently routed by `web-proxy` to the Docker stream service on `127.0.0.1:8788`.

## Known issues

- `brain-web` and `brain-daemon` are currently crash-looping because Bun cannot find the `web` and `daemon` scripts in `/root/Brain`.
- Restarting `octopus.service` restarts `web-proxy`, `auto-x-web`, and the host `auto-x-stream`.

## Safe workflow

1. Edit `config/apps.json` or `src/index.js`.
2. If the systemd service file changed, run `bun run install-service`.
3. Restart with `systemctl restart octopus.service`.
4. Verify with `journalctl -u octopus.service -n 100 --no-pager`.
