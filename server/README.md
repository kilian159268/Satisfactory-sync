# Sync-Server

ASP.NET Core (.NET 10) + SQLite. Vertrag: [`../contracts/openapi.yaml`](../contracts/openapi.yaml),
Hintergrund: [`../docs/PLAN.md`](../docs/PLAN.md) Kapitel 5.

```
src/SatisfactorySync.Core   Lease, Fencing, Upload/Compare-and-swap, Versionen, Aufbewahrung, Save-Header (ohne Web)
src/SatisfactorySync.Api    HTTP-Endpunkte, Token-Anmeldung, Rate-Limits, Kommandozeile
tests/SatisfactorySync.Tests  xUnit: echte HTTP-Tests (WebApplicationFactory, steuerbare Uhr/Platte) + Unit-Tests
```

## Bauen und testen

```sh
cd server
dotnet build -warnaserror          # Analyzer: Warnungen sind Fehler
dotnet test                        # alle Tests
dotnet format --verify-no-changes  # Formatierung prüfen (ohne --verify… korrigieren)
```

Lokal starten (Daten unter `src/SatisfactorySync.Api/data/`):

```sh
dotnet run --project src/SatisfactorySync.Api     # http://127.0.0.1:3160, Health: /healthz
```

Auslieferung für den Root-Server (kein .NET dort nötig):

```sh
dotnet publish src/SatisfactorySync.Api -c Release -r linux-x64 --self-contained -o out/linux-x64
```

## Kommandozeile

Dieselbe Programmdatei, mit einem Befehl als erstem Argument. Sie nutzt dieselbe Konfiguration wie der
Dienst – also als Dienst-Benutzer und mit denselben Umgebungsvariablen aufrufen.

| Befehl | Zweck |
|---|---|
| `invite [--count N]` | N Einladungscodes erzeugen (1–50, Standard 1), einer pro Spieler. Codes werden nur hier angezeigt. |
| `users` | Spieler auflisten (gesperrte mit „(gesperrt)“). |
| `block NAME` | Zugang sperren (Token gilt nicht mehr). |
| `unblock NAME` | Zugang wieder freigeben. |

```sh
sudo -u satisfactory-sync SYNC_CONFIG=/etc/satisfactory-sync/appsettings.json ./SatisfactorySync.Api invite --count 5
```

## Konfiguration

Quellen, später gewinnt: `appsettings.json` neben dem Programm → Datei aus `SYNC_CONFIG`
(Standard `/etc/satisfactory-sync/appsettings.json`, optional) → Umgebungsvariablen
(`:` wird zu `__`, z. B. `Sync__DataDir`).

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `Urls` | `http://127.0.0.1:3160` | Adresse, auf der Kestrel lauscht (nur Loopback; nach außen nur über nginx). |
| `Sync:DataDir` | `data` | SQLite (`sync.db`), Saves (`versions/<id>.sav`), `tmp/`, `orphans/`. Produktion: `/var/lib/satisfactory-sync`. |
| `Sync:PathBase` | leer | Pfad-Präfix, falls der Server unter einem Pfad statt einer eigenen Subdomain läuft (z. B. `/sync`). |
| `Sync:LeaseDuration` | `00:02:00` | Lease-Dauer ohne Heartbeat. |
| `Sync:OfflineAfter` | `00:01:30` | Ohne Lebenszeichen danach „offline“. |
| `Sync:MinFreeBytes` | 2 GiB | Uploads, nach denen weniger frei wäre, werden mit 507 abgelehnt. |
| `Sync:MaxUploadBytes` | 512 MiB | Größenlimit für Saves (413). nginx `client_max_body_size` passend setzen. |
| `Sync:MaxMapBytes` | 4 MiB | Größenlimit für Karten-JSON. |
| `Sync:KeepLatest` / `Sync:KeepDailyDays` | 20 / 30 | Aufbewahrung: letzte N Versionen + eine pro Tag für M Tage; Konfliktkopien M Tage. Head bleibt immer. |
| `Sync:RedeemPerMinute` | 10 | Einlöse-Versuche pro IP und Minute. |
| `Sync:RequestBurst` / `Sync:RequestsPerMinute` | 120 / 120 | Rate-Limit aller übrigen Anfragen pro Spieler bzw. IP. |

Hinter nginx werden `X-Forwarded-For`/`-Proto` von Loopback-Proxys übernommen (für Rate-Limits pro IP).
Außerhalb von `Development` schreibt der Server JSON-Logs auf die Konsole (journald).
