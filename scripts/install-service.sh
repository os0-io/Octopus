#!/usr/bin/env bash
set -euo pipefail

SERVICE_SOURCE="/root/octopus/systemd/octopus.service"
SERVICE_TARGET="/etc/systemd/system/octopus.service"

install -m 0644 "${SERVICE_SOURCE}" "${SERVICE_TARGET}"
systemctl daemon-reload
systemctl enable octopus.service

echo "Installed ${SERVICE_TARGET}"
echo "Start with: systemctl start octopus.service"
