# Designregeln für den Launcher

Gelten für jede Komponente, Seite und Code-Änderung.

## Farben & Flächen (dunkel)
- Dunkelgrau statt Schwarz: Grund `#131416`, höhere Ebenen heller (`#1A1B1E` Kopfzeile/Seitenleiste,
  `#24262B` Hover/Dialoge). Je näher eine Ebene am Nutzer, desto heller.
- Text `#E8E8EA` (kein reines Weiß), Nebentext `#9A9DA5`, deaktiviert `#6E717A`.
- Genau eine Akzentfarbe, hell und entsättigt: `#93B4FF` (Hover `#B9CCFF`), dunkle Schrift darauf (`#0E1526`).
- Keine farbigen Statuspunkte. Status steht als Text; Warnung `#F5C97A`, Fehler `#F2B8B5`.
- Abgrenzung über 1-px-Rahmen (`#2A2C31`, `#3A3D44`), keine Schatten, kein Glassmorphismus,
  keine Farbverläufe, keine Glows.
- So wenig Text wie möglich: ein Titel, höchstens ein kurzer Satz pro Zustand.

## Typografie & Sprache
- Überschriften: Bricolage Grotesque (600/700). Text: Geist (400/500/600), Tabellenziffern.
- Keine Emojis. Keine Marketing-Floskeln. Kurze, konkrete Sätze, die sagen, was passiert.
- Alles auf Deutsch, auch Fehlermeldungen, Platzhalter und Tooltips.

## Layout
- Asymmetrisch: Statusbereich links, „Aktueller Stand“ und „Gruppe“ in einer schmalen Spalte rechts.
- Keine Karten in Karten, keine Icons in farbigen Kästchen, keine Pill-Buttons. Eckenradius 4–8 px.
- Layout umbrechend (flex-wrap), nichts darf bei schmalen Fenstern überlappen.

## Interaktion
- Übergänge nur als Farbwechsel, 150 ms ease. Kein Hüpfen, Skalieren oder Aufleuchten.
- Bewegung nur für Ladezustände (Spinner, Skeletons); `prefers-reduced-motion` wird beachtet.
- Kein toter Knopf und kein `href="#"`: jedes Element tut etwas oder ist mit Begründung deaktiviert.
- Jede Aktion hat einen Ladezustand und eine klare Erfolgs- oder Fehlermeldung.
- Keine Platzhalternamen wie „Alex“, „John Doe“ oder „Acme“.
