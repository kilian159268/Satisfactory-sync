/**
 * electron-builder `afterPack`-Hook: setzt die Electron-Fuses (Plan Kapitel 9) und prüft sie
 * danach. Läuft nach dem Einbetten der ASAR-Integrität und vor dem (hier nicht genutzten)
 * Signieren. Bricht den Build ab, wenn eine Fuse nicht den Sollwert hat.
 */
import { join } from 'node:path';
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';

/** Sollwerte. `true` = an, `false` = aus. */
export const FUSES = {
  // Kein `ELECTRON_RUN_AS_NODE` – die Exe lässt sich nicht als beliebiger Node-Interpreter missbrauchen.
  [FuseV1Options.RunAsNode]: false,
  // Cookies/LocalStorage verschlüsselt ablegen (DPAPI unter Windows).
  [FuseV1Options.EnableCookieEncryption]: true,
  // `NODE_OPTIONS` wird ignoriert (kein Einschleusen von --require …).
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  // `--inspect`, `--inspect-brk` … werden ignoriert (kein Debugger von außen).
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // app.asar wird gegen den in der Exe eingebetteten Hash geprüft.
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  // Nur app.asar wird geladen, kein entpackter `resources/app`-Ordner.
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  // Die UI läuft über app://, file://-Seiten brauchen keine Sonderrechte.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};

const EXE_SUFFIX = { win32: '.exe', darwin: '.app', mas: '.app', linux: '' };

/** Pfad der gepackten Electron-Binary (Windows: `<appOutDir>/Schichtwechsel.exe`). */
function executablePath(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const name =
    electronPlatformName === 'linux' ? packager.executableName : packager.appInfo.productFilename;
  return join(appOutDir, `${name}${EXE_SUFFIX[electronPlatformName] ?? ''}`);
}

export async function verifyFuses(exe) {
  const wire = await getCurrentFuseWire(exe);
  const wrong = Object.entries(FUSES).filter(([key, on]) => {
    const want = on ? FuseState.ENABLE : FuseState.DISABLE;
    return wire[key] !== want;
  });
  if (wrong.length > 0) {
    const names = wrong.map(([key]) => FuseV1Options[Number(key)]).join(', ');
    throw new Error(`Electron-Fuses nicht wie erwartet gesetzt: ${names} (${exe})`);
  }
}

export default async function afterPack(context) {
  const exe = executablePath(context);
  // Über den Packager, damit electron-builder dieselbe @electron/fuses-Version nutzt.
  await context.packager.addElectronFuses(context, { version: FuseVersion.V1, ...FUSES });
  await verifyFuses(exe);
  console.log(`  • Electron-Fuses gesetzt und geprüft: ${exe}`);
}
