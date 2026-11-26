# Designregeln für den Launcher

Gelten für jede Komponente, Seite und Code-Änderung.

## Farben & Flächen
- Heller, ruhiger Grund: `#FAFAFA` (Fläche), `#FFFFFF` (Seitenleiste/Kopfzeile), Text `#111111`, Nebentext `#5B5F66`.
- Genau eine Akzentfarbe für primäre Aktionen: `#1D4ED8` (Hover `#1E40AF`).
- Statusfarben nur für Status: Grün `#16A34A`, Bernstein `#F59E0B`, Rot `#DC2626`.
- Abgrenzung über 1-px-Rahmen (`#E4E4E7`, `#D4D4D8`), keine schweren Schatten, kein Glassmorphismus,
  keine Farbverläufe, keine Glows, keine Neon-Akzente.

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
