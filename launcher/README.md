# V3in-sync (Launcher)

Intern heißen API und Typen weiter `schichtwechsel` (`window.schichtwechsel`, `SchichtwechselApi`).

Electron-Launcher für Satisfactory-sync. Electron + TypeScript (strict) + electron-vite + React 19, Zod, Vitest.
Verbindlich: `../docs/PLAN.md`, `../docs/DESIGN.md`.

## Befehle

| Befehl              | Zweck                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `npm ci`            | Abhängigkeiten; fehlt danach `node_modules/electron/dist`: `node node_modules/electron/install.js` |
| `npm run dev`       | Dev-Modus mit Vite-Server und HMR                                                                  |
| `npm run build`     | Typecheck + Build nach `out/` (main, preload, renderer)                                            |
| `npm run preview`   | Gebauten Stand starten (app://-Protokoll, Prod-CSP)                                                |
| `npm run typecheck` | `tsc` für Node-Teil (main/preload/shared) und Renderer                                             |
| `npm run lint`      | ESLint (typescript-eslint strict, react-hooks)                                                     |
| `npm run format`    | Prettier                                                                                           |
| `npm test`          | Vitest: `tests/main`, `tests/shared` in Node, `tests/renderer` in jsdom                            |

## Aufbau

```
src/shared/channels.ts   IPC-Kanalnamen (ohne Abhängigkeiten, für den Preload)
src/shared/ipc.ts        IPC-Vertrag: Zod-Schemas, Typen, invokeContract, SchichtwechselApi
src/shared/api-types.ts  Server-API: Zod-Schemas + Typen
src/preload/index.ts     contextBridge → window.schichtwechsel
src/main/index.ts        App-Start, Fenster, Single-Instance, app://, CSP, Navigation/Popups blockiert
src/main/security.ts     CSP, openExternal-Allowlist, Absender-URL-Prüfung, app://-Pfadauflösung
src/main/ipc-handlers.ts Handler je Kanal: Absender prüfen → Zod → LauncherBackend → Antwort prüfen
src/main/backend.ts      Interface LauncherBackend + BackendContext
src/main/create-backend.ts  createBackend(context) – einziger Verdrahtungspunkt der Engine
src/main/stub-backend.ts StubBackend mit Testdaten (mit `SCHICHTWECHSEL_STUB=1` statt der echten Engine)
src/renderer/            React-UI (global.d.ts typisiert window.schichtwechsel)
```

## Neuen IPC-Kanal hinzufügen

1. Name in `src/shared/channels.ts`, Schemas in `invokeContract` und Methode in `SchichtwechselApi` (`src/shared/ipc.ts`).
2. Methode in `LauncherBackend` (`src/main/backend.ts`) und Eintrag in `impl` (`src/main/ipc-handlers.ts`).
3. Aufruf im Preload (`src/preload/index.ts`). Der Test „registriert genau die Kanäle aus dem Vertrag“ prüft die Vollständigkeit.
