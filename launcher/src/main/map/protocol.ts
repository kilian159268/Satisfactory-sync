/** Nachrichten zwischen Main und Karten-Worker. */

/** `workerData` beim Start des Workers. */
export interface MapWorkerInput {
  savePath: string;
}

/** Einzige Nachricht des Workers: Ergebnis (wird in Main noch mit `MapDataSchema` geprüft) oder Fehler. */
export type MapWorkerMessage = { ok: true; data: unknown } | { ok: false; error: string };
