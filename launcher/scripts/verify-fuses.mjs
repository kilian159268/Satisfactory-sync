/**
 * Prüft die Electron-Fuses einer gepackten App gegen die Sollwerte aus build/after-pack.mjs.
 * Aufruf: `node scripts/verify-fuses.mjs [pfad-zur-exe]`
 * (Standard: release/win-unpacked/V3in-sync.exe). Exit-Code 1 bei Abweichung.
 */
import { join } from 'node:path';
import { verifyFuses } from '../build/after-pack.mjs';

const exe = process.argv[2] ?? join('release', 'win-unpacked', 'V3in-sync.exe');
try {
  await verifyFuses(exe);
  console.log(`Fuses ok: ${exe}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
