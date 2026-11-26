# Satisfactory-sync (Launcher „V3in-sync“)

Launcher + Server, damit eine Gruppe von 4–5 Leuten Satisfactory ohne Dedicated Server spielt:
Wer zuerst über den Launcher startet, wird Host und bekommt den neuesten Spielstand; danach
landet der neue Stand wieder auf dem Server.

## Zuerst lesen

1. `docs/PLAN.md` – Architektur, Abläufe, API, Fehlerfälle, Meilensteine. **Verbindlich.**
2. `docs/DESIGN.md` – Designregeln für die Oberfläche. **Verbindlich.**
3. `docs/design/launcher-entwurf.dc.html` – klickbarer Entwurf (Aufbau, Zustände, Texte). Das Markup
   ist ein Design-Canvas-Format (`<x-dc>`, `{{…}}`, `<sc-if>`), kein Produktionscode: Aufbau, Farben,
   Abstände und Texte übernehmen, die Technik neu und sauber in React umsetzen.

Weicht etwas Gebautes vom Plan ab, wird erst `docs/PLAN.md` angepasst (mit Begründung), dann der Code.

## Nicht verhandelbar

- Es darf nie zwei Hosts geben, und ein älterer Stand darf nie einen neueren überschreiben
  (Lease + Fencing-Token + Compare-and-swap, siehe Plan 5.3).
- Kein Spielstand wird gelöscht, bevor der Server ihn per SHA-256 bestätigt hat. Lokal wird
  verschoben (Quarantäne/Cache), nicht gelöscht.
- Jeder Fehlerfall aus Plan Kapitel 8 hat einen Test.
- Alle Texte in der Oberfläche auf Deutsch, kurz und konkret.

## Aufbau

```
server/     C# / ASP.NET Core (.NET 10), SQLite – src/SatisfactorySync.Api, src/SatisfactorySync.Core, tests/
launcher/   Electron + TypeScript (strict) + Vite + React – src/main, src/preload, src/renderer, tests/
contracts/  openapi.yaml – Vertrag zwischen Server und Launcher; der TS-Client wird daraus erzeugt
docs/       Plan, Design, Deployment
```

## Qualität

- Kleine, nachvollziehbare Commits; jede Funktion mit Test.
- Server: xUnit, Analyzer mit Warnungen als Fehler, `dotnet format`.
- Launcher: Vitest, ESLint + Prettier, TypeScript `strict`. Electron-Security-Checkliste
  (contextIsolation, sandbox, keine nodeIntegration, CSP, IPC mit Zod validieren).
- Keine geschätzten Annahmen über das Spiel stillschweigend einbauen: Unsicheres steht in Plan
  Kapitel 14 und wird dort abgehakt, sobald es geprüft ist.

## Der Root-Server

- Linux-Root-Server (Distribution zuerst prüfen) mit **max. 8 GB RAM**. Darauf laufen bereits ein **Minecraft-Server**,
  ein **Crafty-Controller-Panel** und ein **Forum** hinter **nginx** (sslip.io-Domain).
- Diese Dienste **nicht anfassen**, nicht neu starten, ihre Konfiguration nicht ändern.
- Vor jeder Änderung an nginx: Konfiguration sichern, `nginx -t`, erst dann `reload` (nie `restart`).
- Der Sync-Server läuft als eigener Benutzer ohne Root-Rechte, als systemd-Dienst, nur auf
  `127.0.0.1`, von außen nur über nginx/HTTPS erreichbar.
- Daten unter `/var/lib/satisfactory-sync/`, Konfiguration unter `/etc/satisfactory-sync/`.
- Vor Paketinstallationen, Firewall-Änderungen oder allem, was andere Dienste beeinflussen kann:
  kurz sagen, was passiert, und nachfragen.
