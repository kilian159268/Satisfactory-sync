import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

const handlers = new Map<string, InvokeHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: InvokeHandler) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

const { registerIpcHandlers, FORBIDDEN_SENDER_ERROR } = await import('../../src/main/ipc-handlers');
const { IPC, STATE_CHANGED_CHANNEL, invokeContract } = await import('../../src/shared/ipc');
const { StubBackend } = await import('../../src/main/stub-backend');

const DEV_URL = 'http://localhost:5173/';

function makeWindow(id = 1) {
  const send = vi.fn();
  const win = {
    isDestroyed: () => false,
    webContents: { id, send },
    minimize: vi.fn(),
    close: vi.fn(),
  };
  return { win, send, asWindow: win as unknown as BrowserWindow };
}

function event(url = 'app://schichtwechsel/index.html', senderId = 1, parent: unknown = null) {
  return {
    sender: { id: senderId },
    senderFrame: { url, parent },
  } as unknown as IpcMainInvokeEvent;
}

function call(channel: string, ev: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`kein Handler für ${channel}`);
  return fn(ev, ...args);
}

const silent = { warn: vi.fn(), error: vi.fn() };

describe('registerIpcHandlers', () => {
  let backend: InstanceType<typeof StubBackend>;
  let window: ReturnType<typeof makeWindow>;
  let dispose: () => void;

  beforeEach(() => {
    handlers.clear();
    backend = new StubBackend({ stepMs: 0 });
    window = makeWindow();
    dispose = registerIpcHandlers({
      backend,
      getWindow: () => window.asWindow,
      devServerUrl: undefined,
      logger: silent,
    });
  });

  it('registriert genau die Kanäle aus dem Vertrag', () => {
    expect([...handlers.keys()].sort()).toEqual(Object.keys(invokeContract).sort());
  });

  it('dispose entfernt alle Handler', () => {
    dispose();
    expect(handlers.size).toBe(0);
  });

  it('liefert für vertrauenswürdige Absender den validierten Zustand', async () => {
    const state = await call(IPC.getState, event());
    expect(state).toMatchObject({ phase: 'verbinden' });
  });

  it('lehnt fremde WebContents ab', async () => {
    await expect(call(IPC.getState, event(undefined, 2))).rejects.toThrow(FORBIDDEN_SENDER_ERROR);
  });

  it('lehnt fremde Origins ab (file://, https, Dev-Server ohne Dev-Modus)', async () => {
    for (const url of [
      'file:///C:/x/index.html',
      'https://evil.example/',
      DEV_URL,
      'app://other/',
    ]) {
      await expect(call(IPC.getState, event(url)), url).rejects.toThrow(FORBIDDEN_SENDER_ERROR);
    }
  });

  it('lehnt Unterframes ab', async () => {
    await expect(call(IPC.getState, event(undefined, 1, {}))).rejects.toThrow(
      FORBIDDEN_SENDER_ERROR,
    );
  });

  it('lehnt Aufrufe ohne Frame oder ohne Fenster ab', async () => {
    const noFrame = { sender: { id: 1 }, senderFrame: null } as unknown as IpcMainInvokeEvent;
    await expect(call(IPC.getState, noFrame)).rejects.toThrow(FORBIDDEN_SENDER_ERROR);

    dispose();
    registerIpcHandlers({ backend, getWindow: () => null, logger: silent });
    await expect(call(IPC.getState, event())).rejects.toThrow(FORBIDDEN_SENDER_ERROR);
  });

  it('ruft das Backend bei fremdem Absender nicht auf', async () => {
    const spy = vi.spyOn(backend, 'restoreVersion');
    await expect(call(IPC.restoreVersion, event('https://evil.example/'), 5)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('validiert Argumente und ruft das Backend bei ungültigen nicht auf', async () => {
    const spy = vi.spyOn(backend, 'restoreVersion');
    for (const bad of [[], ['5'], [-1], [1.5], [5, 6]]) {
      await expect(call(IPC.restoreVersion, event(), ...bad), JSON.stringify(bad)).rejects.toThrow(
        /Ungültige Argumente/,
      );
    }
    expect(spy).not.toHaveBeenCalled();
    await expect(call(IPC.restoreVersion, event(), 200)).resolves.toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalledWith(200);
  });

  it('lehnt unbekannte Einstellungs-Schlüssel ab', async () => {
    await expect(call(IPC.updateSettings, event(), { token: 'x' })).rejects.toThrow(
      /Ungültige Argumente/,
    );
    await expect(call(IPC.updateSettings, event(), { autostart: true })).resolves.toMatchObject({
      autostart: true,
    });
  });

  it('gibt bereinigte Argumente weiter (Trim)', async () => {
    const spy = vi.spyOn(backend, 'redeemInvite');
    await call(IPC.redeemInvite, event(), {
      code: ' ABCD ',
      name: ' Testspieler A ',
      serverUrl: 'https://sync.v3in.de',
    });
    expect(spy).toHaveBeenCalledWith({
      code: 'ABCD',
      name: 'Testspieler A',
      serverUrl: 'https://sync.v3in.de',
    });
  });

  it('wirft, wenn das Backend eine ungültige Antwort liefert', async () => {
    vi.spyOn(backend, 'play').mockResolvedValue({ ok: 'vielleicht' } as never);
    await expect(call(IPC.play, event())).rejects.toThrow(/Interner Fehler/);
  });

  it('akzeptiert im Dev-Modus die Origin des Vite-Servers', async () => {
    dispose();
    registerIpcHandlers({
      backend,
      getWindow: () => window.asWindow,
      devServerUrl: DEV_URL,
      logger: silent,
    });
    await expect(
      call(IPC.getState, event('http://localhost:5173/index.html')),
    ).resolves.toBeTruthy();
    await expect(call(IPC.getState, event('http://localhost:5174/'))).rejects.toThrow(
      FORBIDDEN_SENDER_ERROR,
    );
  });

  it('Fenster-Steuerung minimiert und schließt das Fenster', async () => {
    await call(IPC.windowMinimize, event());
    await call(IPC.windowClose, event());
    expect(window.win.minimize).toHaveBeenCalledOnce();
    expect(window.win.close).toHaveBeenCalledOnce();
  });

  it('pusht State-Änderungen an das Fenster', async () => {
    await backend.start();
    await vi.waitFor(() => {
      expect(window.send).toHaveBeenCalledWith(
        STATE_CHANGED_CHANNEL,
        expect.objectContaining({ phase: 'bereit' }),
      );
    });
  });
});
