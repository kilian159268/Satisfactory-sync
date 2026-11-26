#!/usr/bin/env bash
# Einmalige nginx-Einrichtung für sync.v3in.de (Plan 5.5). Läuft auf dem Entwickler-PC (git-bash).
#
#   deploy/nginx-install.sh           # Site anlegen (bricht ab, wenn sie schon existiert)
#   SS_FORCE=1 deploy/nginx-install.sh  # vorhandene Site-Datei ersetzen (ACHTUNG: überschreibt
#                                       # auch den von certbot ergänzten 443-Block!)
#
# Ablauf auf dem Server: Backup von /etc/nginx nach /root/backup-nginx-<ts>.tar.gz, Datei nach
# sites-available kopieren, Symlink in sites-enabled, `nginx -t`. Nur wenn der Test klappt:
# `systemctl reload nginx` (nie restart). Sonst wird die Änderung zurückgenommen.
#
# Umgebungsvariablen: SS_HOST (root@152.53.125.27), SS_KEY (~/.ssh/v3in_key), SS_PORT (22), SS_FORCE (0)
set -euo pipefail

SS_HOST="${SS_HOST:-root@152.53.125.27}"
SS_KEY="${SS_KEY:-$HOME/.ssh/v3in_key}"
SS_PORT="${SS_PORT:-22}"
SS_FORCE="${SS_FORCE:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/nginx/sync.v3in.de.conf"
TS="$(date +%Y%m%d-%H%M%S)"
REMOTE_TMP="/root/sync.v3in.de.conf.upload-$TS"

test -f "$CONF" || { echo "Fehlt: $CONF" >&2; exit 1; }

echo "==> Lade nginx-Site hoch nach $SS_HOST"
scp -i "$SS_KEY" -P "$SS_PORT" "$CONF" "$SS_HOST:$REMOTE_TMP"

echo "==> Richte nginx-Site ein"
ssh -i "$SS_KEY" -p "$SS_PORT" "$SS_HOST" bash -s -- "$REMOTE_TMP" "$TS" "$SS_FORCE" <<'REMOTE'
set -euo pipefail
SRC="$1"; TS="$2"; FORCE="$3"
NAME=sync.v3in.de
AVAIL="/etc/nginx/sites-available/$NAME"
ENABLED="/etc/nginx/sites-enabled/$NAME"
BACKUP="/root/backup-nginx-$TS.tar.gz"
trap 'rm -f "$SRC"' EXIT

# Gibt es den Hostnamen schon in einer ANDEREN Site? Dann nichts anfassen.
others="$(grep -RlE "server_name[^;]*\b$NAME\b" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null \
          | grep -v -x "$ENABLED" || true)"
if [[ -n "$others" ]]; then
  echo "  !! $NAME ist bereits in einer anderen Konfiguration eingetragen:" >&2
  echo "$others" >&2
  echo "  !! Abbruch, nichts geändert." >&2
  exit 1
fi

if [[ -e "$AVAIL" && "$FORCE" != 1 ]]; then
  echo "  !! $AVAIL existiert schon (evtl. bereits mit certbot-443-Block). Abbruch, nichts geändert." >&2
  echo "  !! Zum Ersetzen: SS_FORCE=1 deploy/nginx-install.sh" >&2
  exit 1
fi

# Vorher prüfen, ob die bestehende Konfiguration überhaupt sauber ist – sonst würden wir
# einen fremden Fehler einem eigenen zuschreiben.
if ! nginx -t >/dev/null 2>&1; then
  echo "  !! nginx -t schlägt schon VOR der Änderung fehl. Abbruch, nichts geändert:" >&2
  nginx -t >&2 || true
  exit 1
fi

echo "  -> Sichere /etc/nginx nach $BACKUP"
tar -czf "$BACKUP" -C / etc/nginx
chmod 0600 "$BACKUP"

PREV=""
if [[ -e "$AVAIL" ]]; then
  PREV="$AVAIL.prev-$TS"
  cp -a "$AVAIL" "$PREV"
fi
HAD_LINK=0
[[ -L "$ENABLED" ]] && HAD_LINK=1

install -m 0644 -o root -g root "$SRC" "$AVAIL"
ln -sfn "$AVAIL" "$ENABLED"

if nginx -t; then
  systemctl reload nginx
  [[ -n "$PREV" ]] && rm -f "$PREV"
  echo "  -> nginx neu geladen (reload). $NAME zeigt auf 127.0.0.1:3160."
else
  echo "  !! nginx -t fehlgeschlagen – nehme Änderung zurück." >&2
  if [[ -n "$PREV" ]]; then
    mv -f "$PREV" "$AVAIL"
  else
    rm -f "$AVAIL"
  fi
  if [[ "$HAD_LINK" != 1 ]]; then
    rm -f "$ENABLED"
  fi
  if nginx -t >/dev/null 2>&1; then
    echo "  !! Ursprünglicher Zustand wiederhergestellt (nginx wurde NICHT neu geladen)." >&2
  else
    echo "  !! nginx -t schlägt weiterhin fehl! Backup: $BACKUP" >&2
  fi
  exit 1
fi
REMOTE

cat <<'HINWEIS'

==> Nächster Schritt: HTTPS-Zertifikat (auf dem Server, sobald DNS auf den Server zeigt):

    ssh -i ~/.ssh/v3in_key root@152.53.125.27
    certbot --nginx -d sync.v3in.de

certbot ergänzt den 443-Block und die Weiterleitung in /etc/nginx/sites-available/sync.v3in.de
und lädt nginx selbst neu. Danach testen:  curl -fsS https://sync.v3in.de/healthz
HINWEIS
