# Auto-Update einbauen (electron-updater)

Updates kommen aus den GitHub Releases von `kilian159268/Satisfactory-sync`
(`publish` in `electron-builder.yml`, gebaut von `.github/workflows/release.yml`).
electron-builder legt dafür `resources/app-update.yml` in die gepackte App und `latest.yml`
in das Release. `electron-updater` steht schon in `dependencies`.

## Schnipsel für `src/main/index.ts`

Import oben bei den anderen Imports:

```ts
import { autoUpdater } from 'electron-updater';
```

Funktion neben `focusMainWindow()`:

```ts
/** Auto-Update über GitHub Releases (Plan 9: Electron aktuell halten). Nur im installierten Build. */
function startAutoUpdate(): void {
  if (!app.isPackaged) return;
  autoUpdater.logger = console;
  // Update wird im Hintergrund geladen und beim nächsten Beenden installiert –
  // also erst nach backend.dispose() (before-quit), nie mitten in einer Host-Sitzung.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater
    .checkForUpdatesAndNotify({
      title: 'Update bereit',
      body: 'Schichtwechsel {version} wird beim nächsten Beenden installiert.',
    })
    .catch((error: unknown) => {
      console.error('[updater] Prüfung fehlgeschlagen', error);
    });
}
```

Aufruf am Ende von `startApp()`, nach `mainWindow = createWindow();`:

```ts
startAutoUpdate();
```

## Hinweise

- Ohne Code-Signing (Plan 9) prüft electron-updater keine Signatur
  (`win.verifyUpdateCodeSignature: false`); SmartScreen kann beim Update-Installer erneut warnen.
- `autoUpdater.logger = console` reicht, solange es kein Datei-Log gibt; später kann hier ein
  Logger mit `info`/`warn`/`error` stehen.
- Die Benachrichtigung nutzt die Windows-Toast-API über die `AppUserModelId`
  (`app.setAppUserModelId` in `startApp()`); die Session-Berechtigungssperre betrifft sie nicht.
- Optional später: Status an die UI melden (`update-available`, `download-progress`,
  `update-downloaded`) – dafür bräuchte es einen IPC-Kanal im Vertrag (`src/shared/ipc.ts`).
- Releases: Version in `launcher/package.json` erhöhen, committen, Tag `v<version>` pushen.
  Der Release-Workflow bricht ab, wenn Tag und Version nicht zusammenpassen.
