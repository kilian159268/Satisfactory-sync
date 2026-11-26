# Satisfactory-sync – Plan

Status: **Abgenommen, bereit zur Umsetzung.** Design-Regeln: [`DESIGN.md`](DESIGN.md),
klickbarer Entwurf: [`design/launcher-entwurf.dc.html`](design/launcher-entwurf.dc.html).

**Name (Arbeitstitel):** Schichtwechsel. **Logo:** V3in-Logo, orange eingefärbt (Datei folgt; bis dahin
das Inline-SVG aus dem Entwurf).

**Rahmen:** 4–5 Spieler, alle gleichberechtigt (kein Admin), **genau ein** gemeinsamer
Spielstand, Windows-PCs mit Steam oder Epic, Server hinter nginx.

---

## 1. Ziel

Eine kleine Gruppe spielt Satisfactory zusammen, ohne Dedicated Server. Wer zuerst über
den Launcher startet, wird **Host** und bekommt automatisch den **neuesten Spielstand**.
Alle anderen starten über den Launcher nur das normale Spiel und treten über Steam/Epic
(Crossplay) bei. Nach der Session liegt der neue Stand wieder zentral auf dem Root-Server.

**Nicht verhandelbar:**

1. Es gibt nie zwei gleichzeitige Hosts desselben Spielstands über den Launcher.
2. Ein älterer Stand kann einen neueren **niemals** überschreiben.
3. Kein Spielstand wird gelöscht, bevor der Server ihn bestätigt (Hash) gespeichert hat.
4. Jeder Fehlerfall (Absturz, Internet weg, PC aus, Doppelklick) endet in einem
   definierten Zustand – im schlimmsten Fall mit einer Konfliktkopie, nie mit Datenverlust.

---

## 2. Grundprinzipien

| Prinzip | Bedeutung |
|---|---|
| **Server ist die einzige Wahrheit** | Welcher Stand der aktuelle ist und wer hostet, entscheidet nur der Server. Der Launcher fragt, er entscheidet nichts allein. |
| **Host-Lease statt einfacher Sperre** | Die Sperre läuft ab, wenn kein Lebenszeichen mehr kommt. Sie kann also nicht ewig hängen bleiben. |
| **Fencing-Token** | Jede Lease hat eine fortlaufende Nummer. Uploads mit veralteter Nummer werden abgelehnt (als Konfliktkopie behalten). So kann ein „Zombie-Host“, dessen Lease schon abgelaufen ist, nichts kaputt machen. |
| **Compare-and-swap beim Upload** | Ein Upload sagt „ich baue auf Version N auf“. Ist der Server nicht mehr bei N, wird nichts überschrieben. |
| **Spielstand nur beim aktuellen Host** | Wer nicht hostet, hat den gemeinsamen Stand nicht im Save-Ordner. Ohne Datei kann man nichts Falsches laden – egal wie das Spiel gestartet wird. |
| **Verschieben statt Löschen** | Lokale Saves werden in einen Quarantäne-Ordner des Launchers verschoben, nie direkt gelöscht. |

Damit ist ein „Direktstart über Steam/Epic verbieten“ nicht nötig – und das wäre ohnehin
nicht zuverlässig machbar. Die Sicherheit kommt aus dem Server, nicht aus dem Startweg.

---

## 3. Architektur

```
 ┌──────────────── Spieler-PC (Windows) ────────────────┐        ┌──── Root-Server ────┐
 │                                                      │        │                     │
 │  Electron-Launcher                                   │ HTTPS  │  Reverse-Proxy      │
 │  ├─ Renderer (UI, React)   ── nur über IPC ──┐       │◄──────►│  (vorhandene Domain)│
 │  └─ Main-Prozess (Node)                      │       │        │        │            │
 │       ├─ Sync-Engine (Zustandsmaschine) ◄────┘       │        │  Sync-API (C#,      │
 │       ├─ Save-Scanner (Header-Parser)                │        │  ASP.NET Core)      │
 │       ├─ Spiel-Starter + Prozess-Wächter             │        │   ├─ SQLite         │
 │       └─ lokales Journal (Crash-Recovery)            │        │   └─ Save-Dateien   │
 │                                                      │        │      + Backups      │
 │  Satisfactory (Steam oder Epic)                      │        └─────────────────────┘
 │  %LOCALAPPDATA%\FactoryGame\Saved\SaveGames\<ID>\    │
 └──────────────────────────────────────────────────────┘
```

**Aufteilung der Technik (Vorschlag):**

- **Launcher: Electron + TypeScript** komplett, also auch die Logik im Main-Prozess.
  Oberfläche in HTML/CSS – Schwerpunkt ist, dass sie richtig gut aussieht (Kapitel 10).
  Node kann alles, was der Launcher braucht (Dateien, Prozesse, HTTP). Ein zusätzlicher
  C#-Prozess auf jedem Spieler-PC würde nur eine zweite Laufzeit, zweite Fehlerquelle und
  ein größeres Installationspaket bedeuten.
- **Server: C# (ASP.NET Core, .NET 10 LTS)** – hier spielt C# seine Stärken aus: Typen,
  saubere Transaktionen, sehr wenig RAM (~50–100 MB), läuft als systemd-Service neben
  Minecraft und Forum.

---

## 4. Abläufe

### 4.1 Launcher öffnen

1. Anmeldung prüfen (Token aus sicherem Speicher).
2. **Recovery:** Liegt im lokalen Journal eine unfertige Session (Absturz, PC aus)?
   → zuerst abschließen (siehe 4.5), erst dann normale Ansicht.
3. Status vom Server holen: Wer hostet? Welche Version ist aktuell, von wann, wie lange gespielt?
4. Läuft Satisfactory schon (außerhalb des Launchers gestartet)? → Host-Knopf gesperrt mit
   Hinweis „Schließ das Spiel zuerst“.
5. Liegen im Save-Ordner Dateien des gemeinsamen Spielstands, obwohl man nicht Host ist?
   → in Quarantäne verschieben (z. B. von Steam-/Epic-Cloud zurückgespielt, siehe 7).

### 4.2 „Spielen“ – niemand hostet → Host werden

1. `POST /lease` – der Server vergibt die Lease **atomar** (SQLite-Transaktion,
   `BEGIN IMMEDIATE`). Antwort: `leaseId`, `fencingToken`, `headVersion`.
   Drücken zwei gleichzeitig, bekommt genau einer die Lease, der andere landet in 4.3.
2. Journal schreiben: „Host, Token X, Basis Version N“.
3. Download der Version N in den Cache → **SHA-256 prüfen** → Header lesen
   (Sessionname, Spielversion).
4. **Spielversion prüfen:** Ist der Save mit einer neueren Spielversion gespeichert als das
   installierte Spiel? → Abbruch mit klarer Meldung („Bitte Satisfactory updaten“), Lease
   zurückgeben.
5. Vorhandene Dateien dieses Spielstands im Save-Ordner → Quarantäne.
6. Save atomar in den Save-Ordner legen (temporäre Datei, dann umbenennen) als
   `<Session>_SYNC.sav`, Änderungszeit = jetzt, damit er im Laden-Menü oben steht.
7. Spiel starten (Steam: `steam://rungameid/526870`, Epic:
   `com.epicgames.launcher://apps/Crab?action=launch&silent=true`), auf den Spielprozess warten.
8. Während das Spiel läuft (siehe 4.4): Heartbeat + laufende Uploads.

### 4.3 „Spielen“ – jemand hostet schon → Mitspieler

1. Anzeige: „**Max** hostet seit 20:14 – tritt über deine Freundesliste bei.“
2. Launcher startet nur das Spiel. Am Save-Ordner wird nichts geändert (außer Quarantäne aus 4.1).

### 4.4 Während der Host spielt

- **Heartbeat** alle 20 s, Lease-Laufzeit 2 min. Ein kurzer Wackler im Internet kostet nichts.
- **Save-Watcher** beobachtet den Save-Ordner. Neue/geänderte `.sav`-Dateien werden nur
  berücksichtigt, wenn
  - die Datei sich 5 s lang nicht mehr verändert (Spiel ist fertig mit Schreiben),
  - der Header lesbar ist und der **Sessionname zum gemeinsamen Spielstand passt**,
  - die Spielzeit im Header ≥ der zuletzt hochgeladenen ist.
- Dann **Upload** (siehe 5.3). Ergebnis: Auch bei einem Absturz fehlen höchstens die
  Minuten seit dem letzten Autosave.
- Empfehlung in der UI: Autosave-Intervall im Spiel auf 5 Minuten stellen.

### 4.5 Spiel wird geschlossen

1. Prozess-Wächter merkt das Ende.
2. Den neuesten passenden Save suchen → falls noch nicht oben: hochladen.
3. Erst wenn der Server **Version + Hash bestätigt** hat:
   alle Dateien des Spielstands aus dem Save-Ordner in den Launcher-Cache verschieben,
   Lease freigeben (`DELETE /lease`), Journal leeren.
4. Kein Internet? → Lease bleibt beim Host (läuft nach 2 min ab), Dateien bleiben liegen,
   Journal bleibt. Beim nächsten Öffnen läuft 4.1 Schritt 2.

**Wichtig für die Spieler:** Satisfactory speichert beim Beenden **nicht automatisch**.
Der Launcher zeigt beim Spielende an, wie alt der letzte Save war, und die Doku sagt:
„Vor dem Beenden einmal speichern.“

### 4.6 Host-Wechsel

Host beendet → Upload → Lease frei → nächster drückt „Spielen“. Mehr braucht es nicht.

---

## 5. Server (C#)

### 5.1 Datenmodell (SQLite)

- `users` – id, name, token-hash, gesperrt
- `world` – genau eine Zeile: satisfactory-sessionname, head_version_id
- `versions` – id, nummer, sha256, größe, spielzeit, spielversion (BuildVersion),
  hochgeladen_von, zeitpunkt, typ (`normal`/`konflikt`/`import`)
- `leases` – höchstens eine Zeile: user_id, fencing_token, basis_version, läuft_ab_um
- `fencing_counter` – streng steigend, nie zurückgesetzt
- `presence` – user_id, status (`launcher`/`im_spiel`), zuletzt_gesehen
- `audit_log` – wer hat wann was gemacht

Es gibt bewusst nur einen Spielstand. Soll später eine zweite Welt (z. B. Testwelt) dazukommen,
wird aus `world` eine Tabelle – die restliche Logik bleibt gleich.

### 5.2 API (Entwurf)

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/world` | Status: Head-Version, aktueller Host, Lease-Ablauf |
| `POST` | `/api/lease` | Host werden (atomar) |
| `PUT` | `/api/lease/heartbeat` | Lease verlängern (mit Token) |
| `DELETE` | `/api/lease` | Lease freigeben (mit Token) |
| `GET` | `/api/versions/{v}/file` | Download (mit `ETag` = SHA-256, Range-Support) |
| `POST` | `/api/versions` | Upload (siehe 5.3) |
| `GET` | `/api/versions` | Verlauf (Backups) |
| `PUT` | `/api/presence` | Lebenszeichen **jedes** Launchers alle 30 s: `launcher` oder `im_spiel` |
| `GET` | `/api/crew` | Alle Spieler mit Status (Launcher offen / im Spiel / zuletzt gesehen) und wer hostet |
| `PUT` | `/api/versions/{v}/map` | Karten-Daten (JSON) zu einer Version ablegen, vom Host-Launcher |
| `GET` | `/api/versions/{v}/map` | Karten-Daten für die Startseite |
| `POST` | `/api/versions/{v}/restore` | Alte Version wieder zum aktuellen Stand machen (nur wenn niemand hostet) |
| `POST` | `/api/lease/force-release` | Hängende Lease lösen (nur wenn sie abgelaufen ist oder der Host selbst es auslöst) |

Alle Spieler sind gleichberechtigt. „Gefährliche“ Aktionen (Wiederherstellen, Lease lösen)
kann jeder auslösen, aber nur mit Bestätigungsdialog und mit Eintrag im Verlauf, den alle sehen.
Wiederherstellen legt eine **neue** Version an – die alte Kette bleibt erhalten.

Der Vertrag wird als **OpenAPI-Datei** festgehalten; der TypeScript-Client im Launcher
wird daraus erzeugt. So können Server und Launcher nicht auseinanderlaufen.

### 5.3 Upload – so wird es wasserdicht

Header: `Lease-Token`, `Base-Version`, `Content-SHA256`, `Idempotency-Key`.

1. Server streamt die Datei in eine temporäre Datei (nie in den RAM).
2. Prüft: Hash stimmt, Header ist parsebar, Sessionname passt, Spielzeit ≥ Basis.
3. **In einer Transaktion:**
   - Lease gültig **und** Token ist das aktuelle **und** `head == Base-Version`?
     → neue Version anlegen, Datei per atomarem Umbenennen ablegen, `head` setzen.
   - Sonst → Datei als **Konfliktkopie** speichern (wird nie automatisch Head),
     Antwort `409` mit Grund. Der Launcher zeigt das klar an.
4. Gleicher `Idempotency-Key` noch mal (z. B. Retry nach Timeout) → gleiche Antwort,
   keine doppelte Version.

### 5.4 Speicher & Backups

- Dateien unter `/var/lib/satisfactory-sync/versions/<version>.sav`, Name = Versionsnummer.
- Aufbewahrung: die letzten 20 Versionen + eine pro Tag für 30 Tage (einstellbar).
- Speicherplatz-Check vor jedem Upload; bei < 2 GB frei wird abgelehnt statt halb geschrieben.
- Saves sind ~10–100 MB und bereits zlib-komprimiert – keine weitere Kompression.

### 5.5 Betrieb

- systemd-Service, läuft als eigener Benutzer ohne Root-Rechte.
- Hinter dem vorhandenen **nginx** mit HTTPS (eigener `location`-Block, `client_max_body_size`
  passend zur Save-Größe, Timeouts für große Uploads). Die genaue Konfiguration kommt in die Doku. Nur HTTPS, kein offener Port nach außen.
- Rate-Limiting (ASP.NET Core hat das eingebaut), Größenlimit für Uploads.
- Log mit strukturierten Einträgen; Health-Endpoint `/healthz`.

### 5.6 Anmeldung

- Einmalig beim Einrichten werden auf dem Server per Kommandozeile **Einladungscodes**
  erzeugt (einer pro Spieler). Jeder gibt seinen Code einmal im Launcher ein und bekommt ein
  persönliches Token. So sieht man, wer hostet, und ein verlorener Zugang lässt sich sperren.
- Server speichert nur den Hash des Tokens. Im Launcher liegt es verschlüsselt über
  Electrons `safeStorage` (Windows: DPAPI).

---

## 6. Launcher (Electron)

### 6.1 Sync-Engine als Zustandsmaschine

Die Logik ist eine explizite Zustandsmaschine – kein Geflecht aus `if`s. Jeder Zustand ist
im Journal gespeichert, damit nach einem Absturz genau dort weitergemacht wird.

```
Leerlauf ──Spielen──► LeaseHolen ──ok──► Herunterladen ──► Vorbereiten ──► SpielStarten
   ▲                     │ belegt                                              │
   │                     ▼                                                     ▼
   │                 Mitspieler ──► SpielStarten(normal)                  Hosten
   │                                                          (Heartbeat + Upload-Schleife)
   │                                                                           │ Spiel zu
   │                                                                           ▼
   └──── Leerlauf ◄── Aufräumen ◄── LeaseFreigeben ◄── Abschluss-Upload ◄── Beenden
                                                              │ kein Netz
                                                              ▼
                                                     WartetAufNetz (Journal bleibt)
```

### 6.2 Plattform & Pfade

- Beim ersten Start: Steam oder Epic **automatisch erkennen** (Installationspfade aus der
  Registry bzw. den Manifesten der Launcher) und zur Bestätigung anzeigen; manuell änderbar.
- Save-Ordner: `%LOCALAPPDATA%\FactoryGame\Saved\SaveGames\<ID>\` – Steam- und Epic-IDs
  liegen dort nebeneinander. Erkennung über das Format (Steam: 17-stellige Zahl,
  Epic: 32 Hex-Zeichen) und die zuletzt geänderten Dateien; bei mehreren Kandidaten fragen.
- Spielprozess: `FactoryGameSteam-Win64-Shipping.exe` bzw. `FactoryGameEGS-Win64-Shipping.exe`.
  Gestartet wird **immer über den Store-Launcher (URI)**, nie die Exe direkt – Steam
  beendet sonst den Prozess und startet ihn neu.
- Installierte Spielversion: aus der `.version`-Datei neben der Exe.

### 6.3 Save-Header lesen

Der Header am Dateianfang ist unkomprimiert und enthält u. a. Header-/Save-/Build-Version,
Sessionname, Spielzeit und Speicherzeitpunkt. Der Launcher liest **nur den Header**
(wenige KB), nie die ganze Datei. Das Format hat sich zwischen Versionen geändert –
der Parser wird mit echten Saves getestet; Referenz: `@etothepii/satisfactory-file-parser`.

### 6.4 Was zum Spielstand gehört

- Die `.sav`-Dateien mit passendem Sessionnamen (Autosaves `<Session>_autosave_0..2.sav`
  und manuelle Saves).
- **Zu prüfen:** Blaupausen liegen pro Session in einem eigenen Ordner unter `SaveGames\blueprints\`.
  Wenn ja, werden sie mitsynchronisiert (als zweite Datei je Version).

---

### 6.5 Anwesenheit („Gruppe“)

- Jeder Launcher meldet sich alle 30 s mit `launcher` oder `im_spiel` (Spielprozess läuft) – auch Mitspieler.
- Nach 90 s ohne Meldung gilt ein Spieler als offline („zuletzt vor …“).
- Die Fußzeile zeigt, wer hostet, und die Verbindung zum Server mit Antwortzeit (aus dem Lebenszeichen gemessen).

### 6.6 Karte

- Nach einem **erfolgreichen** Upload liest der Host-Launcher den Spielstand in einem Worker-Thread
  komplett ein (`@etothepii/satisfactory-file-parser`) und erzeugt eine kleine `map.json`:
  Gebäude zu Clustern zusammengefasst (Position, Anzahl, häufigste Gebäudetypen), Bahnhöfe,
  letzte Spielerpositionen. Die wird an die Version gehängt (`PUT /api/versions/{v}/map`).
- Bewusst im Launcher und nicht auf dem Server: Das Einlesen großer Saves braucht viel RAM,
  der Root-Server hat nur 8 GB und Minecraft läuft dort auch.
- Die Karte wird selbst gezeichnet (SVG). Die Originalkarte des Spiels wird **nicht** verwendet.
- **Gelände (ergänzt 2026-11-26, Wunsch des Betreibers):** Das Spiel speichert keine Landschaft, aber jedes
  Objekt im Spielstand hat eine Höhe. Bodennahe Objekte (Rohstoffvorkommen, Absturzstellen, Fundstücke,
  Tiere, Fracking-Satelliten, Geysire …) sind schon in einem frischen Save über die ganze Welt verteilt
  (geprüft: ~1.200 Punkte auf ~7 × 6 km). Daraus wird ein grobes Höhenraster interpoliert (IDW, ca. 160 × 160
  Zellen, Lücken bleiben leer) und als Teil der `map.json` hochgeladen. Gebäude, Fahrzeuge und Spieler zählen
  nicht als Bodenpunkte (sie stehen auf Fundamenten bzw. fliegen). Das Relief ist eine Schätzung, keine
  Kopie der Spielkarte.
- **Ebenen** in der Oberfläche: *Farbig* (Wasser, Tiefland, Hügel, Berge, Schattierung), *Gedämpft* (dasselbe
  Relief in den Grautönen des Launchers) und *Schematisch* (nur Gitter, wie bisher). Die Wahl bleibt gespeichert.
- Schlägt das Einlesen fehl, hat das keinen Einfluss auf den Sync – die Karte zeigt dann den
  letzten gültigen Stand oder einen leeren Zustand mit Hinweis.
- Die Karte kommt erst nach dem Kern (Meilenstein M4), damit der Sync nicht davon abhängt.

### 6.7 Umgesetzt im Launcher (Ergänzungen, 2026-11-26)

- Abschluss in der Reihenfolge des Diagramms 6.1: erst Lease freigeben, dann aufräumen. Sicher, weil vorher
  der Upload per Hash bestätigt sein muss. Schlägt die Freigabe fehl (offline), läuft die Lease nach 2 min ab.
- Aufräumen: vom Server bestätigte Stände → `cache/archive`, alles andere → Quarantäne. Beides nur Verschieben.
- Uploads während des Spiels laufen über eine Kopie im Cache (`cache/snapshots/<sha>.sav`); ein offener Upload
  wird immer mit demselben Idempotency-Key fertig, bevor ein neuerer Save drankommt.
- Recovery bei laufendem Spiel: ab `vorbereiten` wird weiter gehostet, davor wird die Lease zurückgegeben.
- Allererste Session (Server hat noch keinen Stand): der erste Save nach Host-Start legt die Session fest.
- Quarantäne beim Öffnen nur, wenn das Spiel nicht läuft; sonst nach Spielende.
- Bei mehreren Save-Ordnern gewinnt vorerst der mit dem jüngsten Save (Nachfrage-Dialog offen).
- Karte und Cloud-Erkennung sind optionale Module (`import.meta.glob`); fehlen sie oder scheitern sie, läuft der
  Sync unverändert weiter.
- Karte (6.6): Der Parser läuft im Worker-Thread mit Schutz gegen übergroße Längenangaben, weil die Bibliothek
  bei manchen kaputten Dateien sonst den ganzen Prozess abbricht. **Offen:** Umstieg auf einen eigenen Prozess
  (`utilityProcess`), der auch unentdeckte Absturzpfade abfängt. Im Installer liegt der Worker ausgepackt
  (`asarUnpack`).
- Alle Annahmen über Spiel, Steam und Epic stehen in `launcher/src/main/game-assumptions.ts`,
  `launcher/src/main/map/building-classes.ts` und `launcher/src/main/cloud/constants.ts` (siehe Kapitel 14).

## 7. Steam-/Epic-Cloud – der versteckte Gegner

Beide Stores synchronisieren Satisfactory-Saves in ihre Cloud. Das kann einen Save, den der
Launcher weggeräumt hat, später **zurückspielen**. Deshalb mehrere Schutzschichten:

1. **Empfehlung beim Einrichten:** Cloud-Sync für Satisfactory abschalten (Steam:
   Eigenschaften → Allgemein; Epic: Spiel-Einstellungen). Der Launcher erklärt das mit
   Bildern und erkennt bei Steam, ob es noch an ist.
2. **Selbst wenn ein alter Stand zurückkommt:** Beim Host-Start wird alles mit dem
   Sessionnamen in Quarantäne geschoben und durch die Server-Version ersetzt.
3. **Selbst wenn jemand ohne Launcher einen alten Stand hostet:** Dieser Stand kann den
   Server nie erreichen (Fencing + Compare-and-swap). Schlimmstenfalls hat derjenige
   umsonst gespielt; der gemeinsame Stand bleibt heil.
4. **Erkennung:** Findet der Launcher einen lokalen Stand mit *mehr* Spielzeit als der Server,
   lädt er ihn als Konfliktkopie hoch und meldet es. Die Kopie steht im Verlauf; die Gruppe
   entscheidet, ob sie wiederhergestellt wird.

---

## 8. Fehlerfälle

| Fall | Was passiert |
|---|---|
| Zwei drücken gleichzeitig „Spielen“ | Server vergibt atomar genau eine Lease, der andere wird Mitspieler. |
| Doppelklick / zwei Launcher-Fenster | Launcher erlaubt nur eine Instanz (`requestSingleInstanceLock`). |
| Host-Spiel stürzt ab | Prozess-Ende erkannt → neuester Autosave wird hochgeladen → normaler Abschluss. |
| Host-PC geht aus / Launcher stürzt ab | Lease läuft nach 2 min ab. Beim nächsten Start: Journal → ausstehenden Save hochladen. Ist inzwischen jemand anderes Host gewesen → Konfliktkopie, Hinweis. |
| Internet beim Host weg, Spiel läuft weiter | Heartbeats scheitern; Launcher warnt sichtbar. Nach Ablauf kann ein anderer Host werden; späterer Upload des alten Hosts → Konfliktkopie, nichts wird überschrieben. |
| Upload bricht ab | Retry mit gleichem `Idempotency-Key`; Datei bleibt lokal, bis bestätigt. |
| Download kaputt | SHA-256 stimmt nicht → neu laden; nichts wird in den Save-Ordner gelegt. |
| Save von neuerer Spielversion | Vor dem Start erkannt, klare Meldung, Lease zurück. |
| Host lädt im Spiel einen anderen Spielstand | Nur Saves mit passendem Sessionnamen werden hochgeladen. |
| Server nicht erreichbar | Host werden nicht möglich (klare Meldung); Mitspieler-Start geht trotzdem. |
| Spiel lief schon vor dem Launcher | Host-Knopf gesperrt. |
| Festplatte des Servers voll | Upload wird abgelehnt, Save bleibt lokal, alle Launcher zeigen eine Warnung. |

---

## 9. Sicherheit

**Electron** – nach der offiziellen Security-Checkliste von Electron:

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` im Renderer.
- Renderer spricht nur über eine schmale, typisierte `preload`-API mit dem Main-Prozess;
  jede IPC-Nachricht wird mit **Zod** validiert, Absender geprüft.
- Strikte Content-Security-Policy, keine fremden Inhalte, kein `eval`.
- Navigation und neue Fenster blockiert (`will-navigate`, `setWindowOpenHandler`),
  `shell.openExternal` nur für eine feste Liste von Adressen.
- Eigenes `app://`-Protokoll statt `file://`; Electron-Fuses (z. B. `RunAsNode` aus).
- Electron aktuell halten (Auto-Update).

**Server:** nur HTTPS, Tokens gehasht, Rate-Limits, Größenlimits, Pfade nie aus
Benutzereingaben gebaut, Uploads werden geparst, bevor sie gespeichert werden.

**Hinweis:** Ohne Code-Signing-Zertifikat zeigt Windows SmartScreen beim ersten Start eine
Warnung („Weitere Informationen → Trotzdem ausführen“). Für eine private Gruppe okay.

---

## 10. Oberfläche & Design

Verbindlich sind [`DESIGN.md`](DESIGN.md) und der Entwurf
[`design/launcher-entwurf.dc.html`](design/launcher-entwurf.dc.html) (Aufbau, Zustände, Texte).
Kurzfassung:

- Dunkel, Farben 60/30/10: `#141416` Grund, `#1C1D20` Flächen, Orange `#F59A4A` als einziger Akzent.
- Eine Schrift (Geist, lokal eingebunden), 8-px-Raster, 1-px-Rahmen, keine Schatten/Verläufe/Glows.
- Startseite: Karte oben, darunter Aktionsleiste (Status links; „Nur Spiel starten“ + Hauptknopf rechts),
  Seitenleiste rechts („Aktueller Stand“, „Gruppe“), Fußzeile (wer hostet, Serververbindung).
- Reiter „Verlauf“ (Versionen, Zurückholen mit Bestätigung) und „Einstellungen“
  (Plattform, Spielstand-Ordner, Autostart).
- Eigene Titelleiste (rahmenloses Fenster), Tray-Symbol, Mindestgröße 960 × 600.
- Jeder Zustand aus 6.1 hat eine Ansicht im Entwurf; Ladezustände mit Spinner/Skeleton.

**Im Entwurf noch zu klären:** Der Knopf „Session-Code kopieren“ setzt voraus, dass das Spiel einen
Beitrittscode anzeigt, den der Launcher auslesen kann. Wird in M0 geprüft; sonst entfällt der Knopf.

---

## 11. Projektstruktur & Werkzeuge

```
satisfactory-sync/
├─ docs/                 Plan, Entscheidungen (ADR), Einrichtung
├─ contracts/openapi.yaml  API-Vertrag
├─ server/               C# / ASP.NET Core, .NET 10
│  ├─ src/SatisfactorySync.Api
│  ├─ src/SatisfactorySync.Core    (Lease-/Versionslogik, ohne Web-Abhängigkeit)
│  └─ tests/                       (xUnit, inkl. Parallelitäts-Tests)
├─ launcher/             Electron + TypeScript (strict) + Vite + React
│  ├─ src/main           Sync-Engine, Dateien, Prozesse, IPC
│  ├─ src/preload        schmale API
│  ├─ src/renderer       UI
│  └─ tests/             Vitest (Zustandsmaschine, Header-Parser)
└─ .github/workflows     CI: Build, Tests, Lint; Release baut Installer
```

- Launcher-Installer: **electron-builder** (NSIS) + **electron-updater** über GitHub Releases.
- Code-Qualität: ESLint + Prettier, `dotnet format`, Analyzer auf „Warnung = Fehler“.
- Commits klein und nachvollziehbar, jede Funktion mit Test.

---

## 12. Tests

- **Server:** 50 parallele `POST /lease` → genau einer gewinnt. Upload mit altem Token →
  Konfliktkopie. Upload mit falscher Basis → 409. Gleicher Idempotency-Key doppelt →
  eine Version.
- **Launcher:** Zustandsmaschine mit simuliertem Dateisystem und Server; jeder Übergang
  und jeder Fehlerfall aus Kapitel 8 als Test. Absturz in jedem Zustand → Recovery.
- **Header-Parser:** mit echten Saves aus dem aktuellen Spiel.
- **End-to-End:** Probesession mit zwei PCs (einmal Steam, einmal Epic).

---

## 13. Meilensteine

| # | Inhalt | Wo |
|---|---|---|
| **M1** | Server: Lease, Fencing, Versionen, Upload/Download, Anwesenheit, Tests. | Code: überall; Deployment: Root-Server |
| **M2** | Deployment: systemd-Dienst, nginx-`location`, HTTPS, Einladungscodes für die Gruppe. | Root-Server |
| **M3** | Launcher-Kern ohne UI: Zustandsmaschine, Journal, Pfade, Header-Parser, Prozess-Wächter, Recovery. | Code; Test auf Windows |
| **M4** | Oberfläche nach Entwurf, Tray, Autostart, danach Karte. | Code; Test auf Windows |
| **M5** | Härtung (alle Fälle aus Kapitel 8), Cloud-Erkennung, Installer + Auto-Update über GitHub Actions (`windows-latest`). | Code/CI |
| **M6** | Testrunde mit der Gruppe (ein Steam-, ein Epic-PC), dann 1.0. | Windows-PCs |

Die Windows-Teile (M3–M6) lassen sich auf dem Linux-Server nur bauen und unit-testen; echte
Tests mit Satisfactory laufen auf einem Windows-PC. Die Prüfpunkte aus Kapitel 14 werden dort
als Erstes abgehakt.

---

## 14. Noch zu prüfen / Entscheidungen

**Am echten Windows-PC zu prüfen (vor bzw. in M3):**

- [ ] Epic-Start-URI mit App-Name `Crab` startet das Spiel ohne Launcher-Fenster.
- [ ] Prozessnamen nach Start über Steam/Epic (Steam startet eventuell neu).
- [ ] Header-Format eines aktuellen Saves (Beispiel-Save).
- [ ] Liegen Blaupausen pro Session in eigenem Ordner?
- [ ] Verhalten der Steam-/Epic-Cloud, wenn ein Save außerhalb des Spiels verschoben wird.
- [ ] Gibt es einen Beitrittscode, den der Launcher anzeigen kann?

**Entschieden:**

- Launcher: Electron + TypeScript (Logik und UI). Server: C# / ASP.NET Core (.NET 10), SQLite.
- nginx als Reverse-Proxy; API unter einem eigenen Pfad der vorhandenen Domain (z. B. `/sync/`).
- 4–5 Spieler, alle gleichberechtigt, kein Admin. Genau ein gemeinsamer Spielstand.
- Dunkles Design nach `DESIGN.md`, Logo = V3in-Logo in Orange.
