#!/usr/bin/env bash
# Erzeugt Einladungscodes auf dem Server (Plan 5.6). Läuft auf dem Entwickler-PC (git-bash).
#
#   deploy/invite.sh 5      # fünf Codes (einer pro Spieler)
#
# Umgebungsvariablen: SS_HOST (root@152.53.125.27), SS_KEY (~/.ssh/v3in_key), SS_PORT (22)
set -euo pipefail

SS_HOST="${SS_HOST:-root@152.53.125.27}"
SS_KEY="${SS_KEY:-$HOME/.ssh/v3in_key}"
SS_PORT="${SS_PORT:-22}"

COUNT="${1:-}"
if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || (( COUNT < 1 || COUNT > 50 )); then
  echo "Aufruf: $0 ANZAHL   (1–50)" >&2
  exit 2
fi

# Gleiche Umgebung wie in satisfactory-sync.service; als Dienstbenutzer, damit die
# Datenbank-Dateien ihm gehören. Logs gehen nach stderr, die Codes nach stdout.
ssh -i "$SS_KEY" -p "$SS_PORT" "$SS_HOST" bash -s -- "$COUNT" <<'REMOTE'
set -euo pipefail
cd /opt/satisfactory-sync
sudo -u satisfactory-sync env -i \
  PATH=/usr/bin:/bin \
  ASPNETCORE_ENVIRONMENT=Production \
  Sync__DataDir=/var/lib/satisfactory-sync \
  SYNC_CONFIG=/etc/satisfactory-sync/appsettings.json \
  DOTNET_gcServer=0 \
  DOTNET_NOLOGO=1 \
  Logging__LogLevel__Default=Warning \
  /opt/satisfactory-sync/SatisfactorySync.Api invite --count "$1"
REMOTE
