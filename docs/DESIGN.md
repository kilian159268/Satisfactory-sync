# Designregeln für den Launcher

Gelten für jede Komponente, Seite und Code-Änderung.

## Farben (60 / 30 / 10)
- **60 % Grundfläche:** `#141416` (Karte, Hauptbereich). Dunkelgrau, kein Schwarz.
- **30 % Flächen:** `#1C1D20` (Kopfzeile, Seitenleiste, Aktionsleiste, Fußzeile), Rahmen `#2A2B30` / `#3A3B41`.
- **10 % Akzent:** Orange `#F59A4A` (Hover `#F8B176`, Schrift darauf `#1B1006`), nur für Hauptaktion,
  Host-Kennzeichnung, Auswahl und Logo. Logo: Sechseck und linker Strich `#F59A4A`, rechter Strich `#FBC793`.
- Text `#ECECEE`, Nebentext `#9B9DA4`, inaktiv `#6C6E75`, Fehler `#F2B8B5`.
- Keine farbigen Statuspunkte, keine Schatten, keine Verläufe, keine Glows.

## Schrift & Abstände
- Eine Schrift: **Geist** (400/500/600). Größen: 12, 13, 14, 16, 20, 28 px.
- Abstände nur aus dem 8-px-Raster: 8, 16, 24, 32 (4 nur innerhalb kleiner Elemente).
- Keine Emojis, keine Floskeln, so wenig Text wie möglich, alles auf Deutsch.

## Layout
- Startseite: interaktive Karte oben, darunter die Aktionsleiste mit Status und Knöpfen
  („Nur Spiel starten“ neben dem Hauptknopf). Rechts die Seitenleiste mit klar getrennten Abschnitten
  („Aktueller Stand“, „Gruppe“). Fußzeile: wer hostet und Serververbindung.
- Keine Karten in Karten, keine Icons in farbigen Kästchen, keine Pill-Buttons. Eckenradius 4–8 px.
- Layout umbrechend (flex-wrap), nichts darf bei schmalen Fenstern überlappen.

## Interaktion
- Übergänge nur als Farbwechsel, 150 ms ease. Kein Hüpfen, Skalieren oder Aufleuchten.
- Bewegung nur für Ladezustände (Spinner, Skeletons); `prefers-reduced-motion` wird beachtet.
- Kein toter Knopf und kein `href="#"`: jedes Element tut etwas oder ist mit Begründung deaktiviert.
- Jede Aktion hat einen Ladezustand und eine klare Erfolgs- oder Fehlermeldung.
- Keine Platzhalternamen wie „Alex“, „John Doe“ oder „Acme“.
