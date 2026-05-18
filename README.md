# Octopus

Octopus is a small Bun-based process manager for long-running local services. It
provides an interactive terminal UI for day-to-day control and a headless
`systemd` mode for boot-time startup.

The current deployment is built for a root-managed Linux host where Octopus
lives at `/root/octopus` and Bun is available at `/root/.bun/bin/bun`.

## Features

- Interactive Blessed TUI for starting, stopping, and restarting services.
- Headless `systemd` mode for startup after boot and recovery after crashes.
- Per-service working directories, command arguments, inline environment
  values, and optional `.env` files.
- Runtime state persisted in `/run/octopus/state.json` for crash recovery
  during the current boot.
- Child process stdout and stderr captured into the TUI or the systemd journal.

## Managed Services

The checked-in [`config/apps.json`](config/apps.json) currently manages:

| Service | Working directory | Autostart | Notes |
| --- | --- | --- | --- |
| Brain Web | `/root/Brain` | Yes | Runs `bun run web`. |
| Brain Daemon | `/root/Brain` | Yes | Runs `bun run daemon`. |
| Web Proxy | `/root/web-proxy` | Yes | Runs the Bun web proxy on port `80`. |
| Auto-X Web | `/root/auto-x` | Yes | Runs `npm run start` on port `3000`. |
| Auto-X Stream | `/root/auto-x` | Yes | Runs `npm run stream-server` on port `8787`. |

Adjust this file for the services on the target host before installing the
systemd unit.

## Requirements

- Linux with `systemd`.
- Bash.
- Git access to this repository.
- Bun installed at `/root/.bun/bin/bun`, or matching path updates in
  [`systemd/octopus.service`](systemd/octopus.service) and
  [`config/apps.json`](config/apps.json).
- Node or npm only for managed apps that call npm directly, such as Auto-X.

## Installation

Clone Octopus into the path expected by the service file:

```bash
git clone git@github.com:os0-io/Octopus.git /root/octopus
cd /root/octopus
bun install
```

Review the configured apps:

```bash
cd /root/octopus
$EDITOR config/apps.json
```

Run Octopus interactively:

```bash
cd /root/octopus
bun run start
```

Install and enable the systemd service:

```bash
cd /root/octopus
bun run install-service
systemctl start octopus.service
systemctl status octopus.service
```

The install script copies [`systemd/octopus.service`](systemd/octopus.service)
to `/etc/systemd/system/octopus.service`, reloads systemd, and enables the
service for boot.

## Commands

```bash
bun run start            # Start the interactive TUI
bun run dev              # Start with Bun watch mode
bun run install-service  # Install and enable the systemd unit
```

Useful service commands:

```bash
systemctl restart octopus.service
systemctl stop octopus.service
journalctl -u octopus.service -n 200 --no-pager
```

## TUI Controls

| Key | Action |
| --- | --- |
| `s` | Start the selected app. |
| `x` | Stop the selected app. |
| `r` | Restart the selected app. |
| `q` or `Ctrl-C` | Quit Octopus. |

## Configuration

Apps are defined in [`config/apps.json`](config/apps.json):

```json
{
  "apps": [
    {
      "id": "example-api",
      "name": "Example API",
      "command": "/root/.bun/bin/bun",
      "args": ["run", "start"],
      "cwd": "/root/example-api",
      "envFile": "/root/example-api/.env",
      "env": {
        "PORT": "3000"
      },
      "autostart": true
    }
  ]
}
```

Supported fields:

| Field | Required | Description |
| --- | --- | --- |
| `id` | Yes | Stable identifier used in runtime state. |
| `name` | Yes | Human-readable label shown in the TUI and logs. |
| `command` | Yes | Executable to spawn. Use absolute paths for services. |
| `args` | No | Command arguments. Defaults to an empty list. |
| `cwd` | Yes | Working directory for the child process. |
| `envFile` | No | Optional dotenv-style file loaded before start. |
| `env` | No | Inline environment overrides. Values here override `envFile`. |
| `autostart` | No | Starts the app automatically when no saved state exists. |

Octopus validates that `apps` is a non-empty array and that each app has `id`,
`name`, `command`, and `cwd`.

## Runtime State

Octopus writes runtime state to `/run/octopus/state.json`.

- If Octopus crashes, systemd restarts it and the state file is still present,
  so processes whose desired state was `running` are restored.
- If the host reboots, `/run` is recreated by the operating system and the
  runtime state is discarded.
- Apps that should always return after reboot should set `"autostart": true`.

The systemd unit also sets:

```ini
Environment=OCTOPUS_HEADLESS=1
Environment=OCTOPUS_STATE_DIR=/run/octopus
Environment=OCTOPUS_STATE_PATH=/run/octopus/state.json
```

For local testing, `OCTOPUS_CONFIG_PATH`, `OCTOPUS_STATE_DIR`, and
`OCTOPUS_STATE_PATH` can be overridden in the environment.

## Project Layout

```text
.
|-- config/apps.json              # Managed app definitions
|-- scripts/install-service.sh    # systemd installer
|-- src/index.js                  # TUI, supervisor, state handling
|-- systemd/octopus.service       # Headless boot service
|-- package.json                  # Bun scripts and dependencies
`-- bun.lock
```

## Maintenance Notes

- Keep service command paths absolute. systemd runs Octopus headlessly and does
  not inherit an interactive shell setup.
- Restart `octopus.service` after changing app definitions or runtime code.
- Re-run `bun run install-service` after changing the systemd unit.
- Check `journalctl -u octopus.service` when a managed app exits unexpectedly.
- The repository does not currently publish a package or license.

Last reviewed: 2026-05-18.
