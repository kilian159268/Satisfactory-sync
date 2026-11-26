/**
 * Registriert für jeden Kanal aus `invokeContract` einen Handler, der
 *  1. den Absender prüft (nur Hauptframe unseres Fensters mit app:// bzw. Dev-Server-Origin),
 *  2. die Argumente mit Zod validiert,
 *  3. an das `LauncherBackend` delegiert und
 *  4. die Antwort gegen das Schema prüft.
 * Außerdem werden State-Änderungen des Backends an das Fenster gepusht.
 *
 * Besitz: Fundament. Neue Kanäle zuerst in src/shared/ipc.ts eintragen, dann hier in `impl`.
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  AppStateSchema,
  IPC,
  STATE_CHANGED_CHANNEL,
  invokeContract,
  type InvokeArgs,
  type InvokeContract,
  type InvokeResult,
} from '../shared/ipc';
import type { LauncherBackend } from './backend';
import { isTrustedRendererUrl } from './security';

export interface IpcHandlerOptions {
  backend: LauncherBackend;
  /** Das eine Hauptfenster (oder null, solange keins existiert). */
  getWindow: () => BrowserWindow | null;
  /** URL des Vite-Dev-Servers (nur `npm run dev`), sonst undefined. */
  devServerUrl?: string | undefined;
  logger?: Pick<Console, 'warn' | 'error'>;
}

type Handler<C extends keyof InvokeContract> = (
  ...args: InvokeArgs<C>
) => Promise<InvokeResult<C>> | InvokeResult<C>;
type HandlerMap = { [C in keyof InvokeContract]: Handler<C> };

export const FORBIDDEN_SENDER_ERROR = 'IPC abgelehnt: unbekannter Absender.';

/** Nur der Hauptframe unseres Fensters mit vertrauenswürdiger URL darf IPC benutzen. */
export function isTrustedSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: BrowserWindow | null,
  devServerUrl: string | undefined,
): boolean {
  if (window === null || window.isDestroyed()) return false;
  if (event.sender.id !== window.webContents.id) return false;
  const frame = event.senderFrame;
  if (frame === null) return false;
  if (frame.parent !== null) return false;
  return isTrustedRendererUrl(frame.url, devServerUrl);
}

/** Registriert alle Handler. Rückgabe entfernt sie wieder (Tests, Neustart des Backends). */
export function registerIpcHandlers(options: IpcHandlerOptions): () => void {
  const { backend, getWindow, devServerUrl } = options;
  const logger = options.logger ?? console;

  const impl: HandlerMap = {
    [IPC.getState]: () => backend.getState(),
    [IPC.play]: () => backend.play(),
    [IPC.startGameOnly]: () => backend.startGameOnly(),
    [IPC.retryConnection]: () => backend.retryConnection(),
    [IPC.redeemInvite]: (input) => backend.redeemInvite(input),
    [IPC.listVersions]: () => backend.listVersions(),
    [IPC.restoreVersion]: (id) => backend.restoreVersion(id),
    [IPC.getMap]: (versionId) => backend.getMap(versionId),
    [IPC.getSettings]: () => backend.getSettings(),
    [IPC.updateSettings]: (patch) => backend.updateSettings(patch),
    [IPC.copySessionCode]: () => backend.copySessionCode(),
    [IPC.createLinkCode]: () => backend.createLinkCode(),
    [IPC.windowMinimize]: () => {
      getWindow()?.minimize();
      return undefined;
    },
    [IPC.windowClose]: () => {
      getWindow()?.close();
      return undefined;
    },
  };

  const channels = Object.keys(invokeContract) as (keyof InvokeContract)[];
  for (const channel of channels) {
    // Typen sind über `HandlerMap` gesichert; zur Laufzeit zählt nur das Schema.
    const contract = invokeContract[channel] as {
      args: { safeParse(v: unknown): { success: true; data: unknown[] } | { success: false } };
      result: { safeParse(v: unknown): { success: true; data: unknown } | { success: false } };
    };
    const handler = impl[channel] as (...args: unknown[]) => unknown;

    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...rawArgs: unknown[]) => {
      if (!isTrustedSender(event, getWindow(), devServerUrl)) {
        logger.warn(
          `[ipc] ${channel}: Absender abgelehnt (${event.senderFrame?.url ?? 'ohne Frame'})`,
        );
        throw new Error(FORBIDDEN_SENDER_ERROR);
      }
      const args = contract.args.safeParse(rawArgs);
      if (!args.success) {
        logger.warn(`[ipc] ${channel}: ungültige Argumente`);
        throw new Error(`Ungültige Argumente für ${channel}.`);
      }
      const value = await handler(...args.data);
      const result = contract.result.safeParse(value);
      if (!result.success) {
        logger.error(`[ipc] ${channel}: Backend lieferte eine ungültige Antwort`);
        throw new Error(`Interner Fehler bei ${channel}.`);
      }
      return result.data;
    });
  }

  const unsubscribe = backend.onStateChange((state) => {
    const window = getWindow();
    if (window === null || window.isDestroyed()) return;
    const parsed = AppStateSchema.safeParse(state);
    if (!parsed.success) {
      logger.error('[ipc] Backend lieferte einen ungültigen AppState', parsed.error.issues);
      return;
    }
    window.webContents.send(STATE_CHANGED_CHANNEL, parsed.data);
  });

  return () => {
    unsubscribe();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
