#!/usr/bin/env bash
# Führt einen Befehl der Server-Kommandozeile auf dem Root-Server aus (Plan 5.6). Läuft auf dem
# Entwickler-PC (git-bash). Beispiele:
#
#   deploy/cli.sh users                    # Spieler mit Anzahl Zugänge
#   deploy/cli.sh invite --count 2         # neue Einladungscodes
#   deploy/cli.sh invite --for Veloc       # Code für einen weiteren Zugang (zweites Konto/PC)
#   deploy/cli.sh link Veloc VelocAlt      # zwei Spieler zusammenführen
#   deploy/cli.sh block NAME | unblock NAME
#
# Umgebungsvariablen: SS_HOST (root@152.53.125.27), SS_KEY (~/.ssh/v3in_key), SS_PORT (22)
set -euo pipefail

SS_HOST="${SS_HOST:-root@152.53.125.27}"
SS_KEY="${SS_KEY:-$HOME/.ssh/v3in_key}"
SS_PORT="${SS_PORT:-22}"

if (( $# == 0 )); then
  sed -n '2,10p' "$0" >&2
  exit 2
fi
# Nur harmlose Zeichen weiterreichen (Namen, Zahlen, Optionen) – kein Shell-Code auf dem Server.
for a in "$@"; do
  if ! [[ "$a" =~ ^[A-Za-z0-9._-]{1,32}$ ]]; then
    echo "Ungültiges Argument: $a" >&2
    exit 2
  fi
done

ssh -i "$SS_KEY" -p "$SS_PORT" "$SS_HOST" bash -s -- "$@" <<'REMOTE'
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
  /opt/satisfactory-sync/SatisfactorySync.Api "$@"
REMOTE
