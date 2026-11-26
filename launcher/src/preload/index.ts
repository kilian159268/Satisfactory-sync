/**
 * Schmale, typisierte Brücke zum Main-Prozess. Läuft in der Sandbox: nur `electron` und
 * gebündelte Konstanten, kein Zod (validiert wird im Main-Prozess).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, STATE_CHANGED_CHANNEL } from '../shared/channels';
import type { AppState, SchichtwechselApi } from '../shared/ipc';

const api: SchichtwechselApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: (cb) => {
    // Das Event-Objekt wird bewusst nicht an den Renderer weitergereicht.
    const listener = (_event: IpcRendererEvent, state: AppState): void => {
      cb(state);
    };
    ipcRenderer.on(STATE_CHANGED_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(STATE_CHANGED_CHANNEL, listener);
    };
  },
  play: () => ipcRenderer.invoke(IPC.play),
  startGameOnly: () => ipcRenderer.invoke(IPC.startGameOnly),
  retryConnection: () => ipcRenderer.invoke(IPC.retryConnection),
  redeemInvite: (input) => ipcRenderer.invoke(IPC.redeemInvite, input),
  listVersions: () => ipcRenderer.invoke(IPC.listVersions),
  restoreVersion: (id) => ipcRenderer.invoke(IPC.restoreVersion, id),
  getMap: (versionId) => ipcRenderer.invoke(IPC.getMap, versionId),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  copySessionCode: () => ipcRenderer.invoke(IPC.copySessionCode),
  window: {
    minimize: () => {
      void ipcRenderer.invoke(IPC.windowMinimize);
    },
    close: () => {
      void ipcRenderer.invoke(IPC.windowClose);
    },
  },
};

contextBridge.exposeInMainWorld('schichtwechsel', api);
