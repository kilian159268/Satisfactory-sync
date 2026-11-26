#!/usr/bin/env bash
# Baut den Satisfactory-sync-Server (self-contained linux-x64) und spielt ihn auf den Root-Server.
# Läuft auf dem Windows-Entwickler-PC in git-bash (oder unter Linux/macOS).
#
#   deploy/deploy.sh                # bauen + hochladen + installieren + Healthcheck
#   deploy/deploy.sh --build-only   # nur lokal bauen (deploy/out/), nichts hochladen
#
# Umgebungsvariablen (mit Standardwerten):
#   SS_HOST     Ziel per SSH                (root@152.53.125.27)
#   SS_KEY      SSH-Schlüssel               (~/.ssh/v3in_key)
#   SS_PORT     SSH-Port                    (22)
#   SS_ROLLBACK 1 = bei fehlgeschlagenem Healthcheck automatisch alte Version zurück (1)
#
# Auf dem Server wird NUR der Dienst satisfactory-sync neu gestartet. nginx und alle anderen
# Dienste bleiben unberührt (nginx einmalig: deploy/nginx-install.sh).
set -euo pipefail

SS_HOST="${SS_HOST:-root@152.53.125.27}"
SS_KEY="${SS_KEY:-$HOME/.ssh/v3in_key}"
SS_PORT="${SS_PORT:-22}"
SS_ROLLBACK="${SS_ROLLBACK:-1}"

BUILD_ONLY=0
case "${1:-}" in
  --build-only) BUILD_ONLY=1 ;;
  "") ;;
  -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
  *) echo "Unbekannte Option: $1 (erlaubt: --build-only)" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$REPO_DIR/server/src/SatisfactorySync.Api/SatisfactorySync.Api.csproj"
OUT_DIR="$SCRIPT_DIR/out"
PUBLISH_DIR="$OUT_DIR/publish"
STAGE_DIR="$OUT_DIR/stage"
TS="$(date +%Y%m%d-%H%M%S)"
PACKAGE="$OUT_DIR/satisfactory-sync-$TS.tar.gz"

log() { printf '\n==> %s\n' "$*"; }

# ---------------------------------------------------------------- Bauen
log "Baue self-contained linux-x64 (Release)"
rm -rf "$PUBLISH_DIR" "$STAGE_DIR"
mkdir -p "$PUBLISH_DIR" "$STAGE_DIR/app"

# Kein Trimmen (Reflection in ASP.NET Core/JSON). Kein Single-File: so liegt die native
# SQLite-Bibliothek (libe_sqlite3.so) direkt daneben und muss nicht nach $HOME entpackt
# werden – das wäre mit ProtectHome=true und einem Benutzer ohne Home ohnehin gesperrt.
dotnet publish "$PROJECT" \
  --configuration Release \
  --runtime linux-x64 \
  --self-contained true \
  -p:PublishTrimmed=false \
  -p:PublishSingleFile=false \
  -p:DebugType=none \
  -p:GenerateDocumentationFile=false \
  --output "$PUBLISH_DIR"

test -f "$PUBLISH_DIR/SatisfactorySync.Api" || { echo "Build-Ausgabe ohne SatisfactorySync.Api" >&2; exit 1; }

cp -R "$PUBLISH_DIR/." "$STAGE_DIR/app/"
# Entwicklungs-Einstellungen nicht mit ausliefern.
rm -f "$STAGE_DIR/app/appsettings.Development.json"
cp "$SCRIPT_DIR/satisfactory-sync.service" "$STAGE_DIR/"
cp "$SCRIPT_DIR/appsettings.production.json" "$STAGE_DIR/"
GIT_REV="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unbekannt)"
printf 'rev=%s\nbuilt=%s\n' "$GIT_REV" "$TS" > "$STAGE_DIR/app/BUILD-INFO.txt"

tar -czf "$PACKAGE" -C "$STAGE_DIR" .
log "Paket: $PACKAGE ($(du -h "$PACKAGE" | cut -f1))"

if [[ "$BUILD_ONLY" == 1 ]]; then
  log "Nur gebaut (--build-only). Nichts hochgeladen."
  exit 0
fi

# ---------------------------------------------------------------- Hochladen
SSH_OPTS=(-i "$SS_KEY" -p "$SS_PORT" -o ServerAliveInterval=15)
SCP_OPTS=(-i "$SS_KEY" -P "$SS_PORT")
REMOTE_PKG="/root/satisfactory-sync-upload-$TS.tar.gz"

log "Lade Paket hoch nach $SS_HOST:$REMOTE_PKG"
scp "${SCP_OPTS[@]}" "$PACKAGE" "$SS_HOST:$REMOTE_PKG"

# ---------------------------------------------------------------- Installieren (auf dem Server)
log "Installiere auf $SS_HOST"
ssh "${SSH_OPTS[@]}" "$SS_HOST" bash -s -- "$REMOTE_PKG" "$TS" "$SS_ROLLBACK" <<'REMOTE'
set -euo pipefail
PKG="$1"; TS="$2"; ROLLBACK="$3"

APP=/opt/satisfactory-sync
NEW=/opt/satisfactory-sync.new
DATA=/var/lib/satisfactory-sync
CONF=/etc/satisfactory-sync
UNIT=/etc/systemd/system/satisfactory-sync.service
BACKUP="/root/backup-satisfactory-sync-$TS"
SVC=satisfactory-sync
USR=satisfactory-sync

say() { printf '  -> %s\n' "$*"; }

# Benutzer (idempotent): Systembenutzer ohne Login, ohne Home.
if ! id -u "$USR" >/dev/null 2>&1; then
  say "Lege Systembenutzer $USR an"
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$USR"
fi

# Ordner (idempotent).
install -d -m 0755 -o root -g root "$APP"
install -d -m 0750 -o "$USR" -g "$USR" "$DATA"
install -d -m 0750 -o root -g "$USR" "$CONF"

# Paket auspacken.
STAGE="$(mktemp -d /root/satisfactory-sync-stage.XXXXXX)"
trap 'rm -rf "$STAGE" "$NEW"' EXIT
tar -xzf "$PKG" -C "$STAGE"
rm -f "$PKG"

# Konfiguration nur beim ersten Mal anlegen – nie eine vorhandene überschreiben.
if [[ ! -f "$CONF/appsettings.json" ]]; then
  say "Lege $CONF/appsettings.json aus Vorlage an"
  install -m 0640 -o root -g "$USR" "$STAGE/appsettings.production.json" "$CONF/appsettings.json"
else
  say "$CONF/appsettings.json vorhanden – bleibt unverändert"
fi

# Neue Programmdateien vorbereiten (gehören root, Dienst darf nur lesen).
rm -rf "$NEW"
mkdir -p "$NEW"
cp -a "$STAGE/app/." "$NEW/"
chown -R root:root "$NEW"
find "$NEW" -type d -exec chmod 0755 {} +
find "$NEW" -type f -exec chmod 0644 {} +
chmod 0755 "$NEW/SatisfactorySync.Api"

# Unit installieren.
# Dienst anhalten, sichern, austauschen.
if systemctl is-active --quiet "$SVC"; then
  say "Stoppe $SVC"
  systemctl stop "$SVC"
fi

say "Sichere alte Version nach $BACKUP"
mkdir -p "$BACKUP"
if [[ -n "$(ls -A "$APP" 2>/dev/null)" ]]; then
  mkdir -p "$BACKUP/app"
  cp -a "$APP/." "$BACKUP/app/"
fi
if [[ -f "$UNIT" ]]; then
  cp -a "$UNIT" "$BACKUP/satisfactory-sync.service"
fi
# Datenbank-Schnappschuss (Dienst steht, daher konsistent). Saves selbst sind groß und
# werden nicht kopiert – die sind versioniert und werden nie überschrieben.
for f in "$DATA"/sync.db "$DATA"/sync.db-wal "$DATA"/sync.db-shm; do
  if [[ -f "$f" ]]; then
    mkdir -p "$BACKUP/data"
    cp -a "$f" "$BACKUP/data/"
  fi
done

UNIT_CHANGED=0
if ! cmp -s "$STAGE/satisfactory-sync.service" "$UNIT"; then
  install -m 0644 -o root -g root "$STAGE/satisfactory-sync.service" "$UNIT"
  UNIT_CHANGED=1
fi

say "Tausche Programmdateien aus"
rm -rf "$APP.old"
mv "$APP" "$APP.old"
mv "$NEW" "$APP"
rm -rf "$APP.old"

systemctl daemon-reload
if [[ "$UNIT_CHANGED" == 1 ]] || ! systemctl is-enabled --quiet "$SVC"; then
  systemctl enable "$SVC" >/dev/null 2>&1 || true
fi
say "Starte $SVC neu"
systemctl restart "$SVC"

# Healthcheck (bis zu 30 s).
ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:3160/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

if [[ "$ok" == 1 ]]; then
  say "Healthcheck ok: $(curl -fsS --max-time 2 http://127.0.0.1:3160/healthz)"
else
  echo "  !! Healthcheck fehlgeschlagen. Letzte Logzeilen:" >&2
  journalctl -u "$SVC" -n 40 --no-pager >&2 || true
  if [[ "$ROLLBACK" == 1 && -d "$BACKUP/app" ]]; then
    echo "  !! Rollback auf $BACKUP" >&2
    systemctl stop "$SVC" || true
    rm -rf "$APP"
    cp -a "$BACKUP/app" "$APP"
    if [[ -f "$BACKUP/satisfactory-sync.service" ]]; then
      cp -a "$BACKUP/satisfactory-sync.service" "$UNIT"
    fi
    systemctl daemon-reload
    systemctl restart "$SVC"
    sleep 3
    curl -fsS --max-time 2 http://127.0.0.1:3160/healthz >/dev/null 2>&1 \
      && echo "  !! Alte Version läuft wieder." >&2 \
      || echo "  !! Auch die alte Version antwortet nicht – bitte Logs prüfen." >&2
  fi
  exit 1
fi

# Nur die letzten 5 Programm-Backups behalten (nur eigene Ordner).
mapfile -t old < <(ls -1d /root/backup-satisfactory-sync-* 2>/dev/null | sort | head -n -5)
for d in "${old[@]}"; do
  if [[ -n "$d" && "$d" == /root/backup-satisfactory-sync-* ]]; then
    rm -rf -- "$d"
  fi
done
say "Fertig. Version: $(tr '\n' ' ' < "$APP/BUILD-INFO.txt")"
REMOTE

log "Deployment abgeschlossen."
