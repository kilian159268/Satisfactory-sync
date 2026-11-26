# Deployment – Satisfactory-sync auf dem Root-Server

Stand: M2. Zielserver: Ubuntu 24.04, `root@152.53.125.27`, SSH-Schlüssel `~/.ssh/v3in_key`.
Domain: **`sync.v3in.de`**. Alles in `deploy/` (siehe Plan 5.5).

| Was | Wo auf dem Server |
|---|---|
| Programm (self-contained linux-x64, kein .NET nötig) | `/opt/satisfactory-sync/` (gehört root, nur lesbar für den Dienst) |
| Konfiguration | `/etc/satisfactory-sync/appsettings.json` (Vorlage: `deploy/appsettings.production.json`) |
| Daten (SQLite + Spielstände) | `/var/lib/satisfactory-sync/` (`sync.db`, `versions/`, `tmp/`) |
| systemd-Dienst | `/etc/systemd/system/satisfactory-sync.service`, Benutzer `satisfactory-sync` |
| nginx-Site | `/etc/nginx/sites-available/sync.v3in.de` + Symlink in `sites-enabled/` |
| Lauscht auf | nur `127.0.0.1:3160`, von außen nur über nginx/HTTPS |
| Programm-Backups | `/root/backup-satisfactory-sync-<zeitstempel>/` (die letzten 5) |
| nginx-Backups | `/root/backup-nginx-<zeitstempel>.tar.gz` |

**Grundregeln:** Minecraft, Crafty, das Forum und alle anderen Dienste werden nicht angefasst.
Die Skripte starten nur `satisfactory-sync` neu; nginx wird nur per `reload` (nie `restart`) und
nur nach erfolgreichem `nginx -t` neu geladen. Keine Paketinstallation, keine Firewall-Änderung.

Alle Skripte laufen auf dem **Windows-PC in git-bash** im Repo-Ordner. Ziel und Schlüssel lassen
sich per Umgebungsvariable ändern: `SS_HOST` (Standard `root@152.53.125.27`), `SS_KEY`
(`~/.ssh/v3in_key`), `SS_PORT` (`22`).

Voraussetzungen auf dem PC: .NET 10 SDK, git-bash (bringt `ssh`, `scp`, `tar` mit).

---

## 1. DNS prüfen

Der A-Eintrag `sync.v3in.de` muss auf `152.53.125.27` zeigen, bevor certbot laufen kann.

```bash
nslookup sync.v3in.de            # Windows / git-bash
# oder
dig +short sync.v3in.de          # falls dig vorhanden
```

Erwartet: `152.53.125.27`. Falls es auch einen AAAA-Eintrag (IPv6) gibt, muss der ebenfalls auf
diesen Server zeigen – sonst schlägt die Let's-Encrypt-Prüfung fehl. Kein AAAA-Eintrag ist okay.

Freien Port prüfen (nur lesen):

```bash
ssh -i ~/.ssh/v3in_key root@152.53.125.27 'ss -ltnp | grep -w 3160 || echo "3160 frei"'
```

## 2. Erstinstallation des Dienstes

```bash
deploy/deploy.sh --build-only   # optional: nur bauen und prüfen, nichts hochladen
deploy/deploy.sh                # bauen, hochladen, installieren, starten, Healthcheck
```

Was `deploy.sh` macht:

1. `dotnet publish` Release, `linux-x64`, self-contained, **ohne** Trimmen, kein Single-File
   (die native SQLite-Bibliothek liegt dann direkt neben dem Programm). Ergebnis in `deploy/out/`
   (nicht im Git).
2. Paket per `scp` nach `/root/` hochladen.
3. Auf dem Server (idempotent): Systembenutzer `satisfactory-sync` anlegen (ohne Login, ohne Home),
   Ordner `/opt/…`, `/var/lib/…`, `/etc/…` anlegen. Die Konfiguration wird **nur beim ersten Mal**
   aus der Vorlage angelegt, eine vorhandene nie überschrieben.
4. Dienst stoppen, altes `/opt/satisfactory-sync` + Unit + Schnappschuss von `sync.db` nach
   `/root/backup-satisfactory-sync-<ts>/` sichern, Dateien austauschen.
5. `systemctl daemon-reload`, `systemctl enable` (beim ersten Mal), `systemctl restart satisfactory-sync`.
6. Healthcheck `curl -fsS http://127.0.0.1:3160/healthz` (bis zu 30 s). Schlägt er fehl, werden die
   letzten Logzeilen gezeigt und automatisch die vorige Version zurückgespielt
   (abschaltbar mit `SS_ROLLBACK=0`).

Danach auf dem Server prüfen:

```bash
systemctl status satisfactory-sync --no-pager
curl -fsS http://127.0.0.1:3160/healthz
```

Konfiguration anpassen (z. B. Aufbewahrung, Upload-Limit): `/etc/satisfactory-sync/appsettings.json`
bearbeiten, dann `systemctl restart satisfactory-sync`. Wird `MaxUploadBytes` über ~590 MB erhöht,
auch `client_max_body_size` in der nginx-Site anheben.

## 3. nginx einrichten (einmalig)

```bash
deploy/nginx-install.sh
```

Das Skript

- bricht ab, ohne etwas zu ändern, wenn `nginx -t` schon vorher fehlschlägt, wenn `sync.v3in.de`
  bereits in einer anderen Site steht oder die Datei schon existiert,
- sichert `/etc/nginx` nach `/root/backup-nginx-<ts>.tar.gz`,
- kopiert `deploy/nginx/sync.v3in.de.conf` nach `sites-available/sync.v3in.de` und legt den Symlink
  in `sites-enabled/` an,
- führt `nginx -t` aus: nur bei Erfolg `systemctl reload nginx`, sonst wird die Datei wieder
  entfernt und nginx nicht neu geladen.

Die Site lauscht zunächst nur auf Port 80. Test (vor dem Zertifikat):

```bash
curl -fsS http://sync.v3in.de/healthz
```

Eine spätere Änderung an der Site-Datei: `SS_FORCE=1 deploy/nginx-install.sh` – **Achtung**, das
überschreibt auch den von certbot ergänzten 443-Block. Danach certbot erneut ausführen (Schritt 4),
oder kleine Änderungen lieber direkt auf dem Server machen (vorher sichern, `nginx -t`, `reload`).

## 4. HTTPS mit certbot

Auf dem Server, sobald DNS stimmt und Schritt 3 erledigt ist:

```bash
ssh -i ~/.ssh/v3in_key root@152.53.125.27
certbot --nginx -d sync.v3in.de
```

certbot ändert nur die Datei `sites-available/sync.v3in.de` (443-Block + Weiterleitung von HTTP
auf HTTPS) und lädt nginx selbst neu. Bei der Frage nach Weiterleitung: **Redirect** wählen.
Die automatische Verlängerung läuft über den vorhandenen certbot-Timer (`systemctl list-timers | grep certbot`).

Test vom PC:

```bash
curl -fsS https://sync.v3in.de/healthz
```

## 5. Einladungscodes erzeugen

Ein Code pro Spieler:

```bash
deploy/invite.sh 5
```

Die Codes erscheinen in der Ausgabe – sicher an die Spieler weitergeben (nicht in öffentliche Kanäle).
Jeder gibt seinen Code einmal im Launcher ein, zusammen mit seinem Namen.

Weitere Befehle direkt auf dem Server (gleiche Umgebung wie der Dienst):

```bash
cd /opt/satisfactory-sync
sudo -u satisfactory-sync env Sync__DataDir=/var/lib/satisfactory-sync \
  SYNC_CONFIG=/etc/satisfactory-sync/appsettings.json ASPNETCORE_ENVIRONMENT=Production \
  ./SatisfactorySync.Api users          # Spieler auflisten
#   ... block NAME / unblock NAME       # Zugang sperren / entsperren
```

### Zweites Spielkonto oder zweiter PC

Ein Spieler kann mehrere Zugänge haben; in der Gruppe bleibt er eine Person (ein Name, ein Verlauf).

- Selbst im Launcher: **Einstellungen → Zweiten Zugang verknüpfen** → Code auf dem anderen Konto/PC beim
  Anmelden eingeben (24 Std. gültig, einmal einlösbar; der Name wird dabei ignoriert).
- Als Betreiber: `deploy/cli.sh invite --for NAME` erzeugt denselben Code.
- Hat jemand schon zwei Einladungscodes eingelöst (z. B. „Veloc“ und „VelocAlt“):
  `deploy/cli.sh link Veloc VelocAlt` – „VelocAlt“ wird ein weiterer Zugang von „Veloc“; Versionen, Verlauf und
  eine laufende Host-Rolle gehen mit.
- `deploy/cli.sh users` zeigt die Spieler mit Anzahl der Zugänge.

## 6. Update

Neuen Stand bauen und ausrollen – derselbe Befehl wie bei der Erstinstallation:

```bash
deploy/deploy.sh
```

Spielstände und Datenbank bleiben unter `/var/lib/satisfactory-sync` unverändert; die
Konfiguration unter `/etc/satisfactory-sync` wird nicht überschrieben. Am besten updaten, wenn
gerade niemand hostet (`GET /api/world` → `host: null`): ein laufender Host verliert sonst kurz die
Verbindung; der Launcher wiederholt Heartbeat/Upload, solange die Lease nicht abgelaufen ist
(Standard 2 min).

Welche Version läuft: `cat /opt/satisfactory-sync/BUILD-INFO.txt` (Git-Commit + Bauzeit).

## 7. Rollback

`deploy.sh` rollt bei fehlgeschlagenem Healthcheck selbst zurück. Manuell auf eine ältere Version:

```bash
ssh -i ~/.ssh/v3in_key root@152.53.125.27
ls -1d /root/backup-satisfactory-sync-*            # Backup auswählen
B=/root/backup-satisfactory-sync-20261126-140558    # Beispiel
cat "$B/app/BUILD-INFO.txt"
systemctl stop satisfactory-sync
rm -rf /opt/satisfactory-sync && cp -a "$B/app" /opt/satisfactory-sync
cp -a "$B/satisfactory-sync.service" /etc/systemd/system/satisfactory-sync.service  # falls vorhanden
systemctl daemon-reload && systemctl start satisfactory-sync
curl -fsS http://127.0.0.1:3160/healthz
```

Die Datenbank wird beim Rollback **nicht** zurückgesetzt (sonst gingen neuere Versionen verloren).
Nur wenn ein Update das Datenbankschema kaputt gemacht hat: bei gestopptem Dienst `"$B/data/sync.db*"`
nach `/var/lib/satisfactory-sync/` kopieren (`chown satisfactory-sync:` nicht vergessen) – dabei
gehen Einträge seit dem Update verloren; die `.sav`-Dateien in `versions/` bleiben erhalten.

nginx zurücksetzen (nur unsere Site):

```bash
rm /etc/nginx/sites-enabled/sync.v3in.de /etc/nginx/sites-available/sync.v3in.de
nginx -t && systemctl reload nginx
```

Komplettes nginx aus dem Backup (nur im Notfall, betrifft alle Sites):
`tar -xzf /root/backup-nginx-<ts>.tar.gz -C /` → `nginx -t` → `systemctl reload nginx`.

## 8. Logs

```bash
journalctl -u satisfactory-sync -f                    # live
journalctl -u satisfactory-sync --since "1 hour ago"  # letzte Stunde
journalctl -u satisfactory-sync -p warning            # nur Warnungen und Fehler
tail -f /var/log/nginx/sync.v3in.de.access.log /var/log/nginx/sync.v3in.de.error.log
```

Der Dienst schreibt strukturierte JSON-Zeilen (eine pro Eintrag). Speicher-/CPU-Verbrauch:
`systemctl status satisfactory-sync` (Obergrenze `MemoryMax=300M`).

## 9. Backups der Daten

Alles Wichtige liegt in `/var/lib/satisfactory-sync/`:

- `sync.db` (+ `-wal`, `-shm`) – Versionen, Spieler, Tokens (nur Hashes), Lease, Audit-Log
- `versions/*.sav` – die Spielstände selbst (werden nie überschrieben, nur nach Aufbewahrungsregel
  gelöscht: letzte 20 + eine pro Tag für 30 Tage)

Konsistentes Backup ohne den Dienst anzuhalten geht nicht ohne `sqlite3`; deshalb kurz stoppen
(der Launcher wiederholt in der Zeit nur):

```bash
TS=$(date +%Y%m%d-%H%M%S)
systemctl stop satisfactory-sync
tar -czf /root/backup-satisfactory-sync-data-$TS.tar.gz -C /var/lib satisfactory-sync
systemctl start satisfactory-sync
```

Vom PC herunterladen:

```bash
scp -i ~/.ssh/v3in_key root@152.53.125.27:/root/backup-satisfactory-sync-data-<ts>.tar.gz .
```

Speicherplatz im Blick behalten: `df -h /var/lib/satisfactory-sync` und
`du -sh /var/lib/satisfactory-sync/versions`. Der Server lehnt Uploads ab, wenn danach weniger als
2 GB frei wären (`MinFreeBytes`). Hinweis:
die Programm-Backups enthalten nur einen Schnappschuss von `sync.db`, keine Spielstände.

Wiederherstellen: Dienst stoppen, Ordner ersetzen
(`tar -xzf … -C /var/lib`), `chown -R satisfactory-sync:satisfactory-sync /var/lib/satisfactory-sync`,
Dienst starten.

## 10. Entfernen (falls nötig)

```bash
systemctl disable --now satisfactory-sync
rm /etc/systemd/system/satisfactory-sync.service && systemctl daemon-reload
rm /etc/nginx/sites-enabled/sync.v3in.de /etc/nginx/sites-available/sync.v3in.de
nginx -t && systemctl reload nginx
# Programm/Daten/Konfiguration erst löschen, wenn ein Daten-Backup existiert:
# rm -rf /opt/satisfactory-sync /etc/satisfactory-sync /var/lib/satisfactory-sync
# userdel satisfactory-sync
# Zertifikat: certbot delete --cert-name sync.v3in.de
```
