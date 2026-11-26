/**
 * IPC-Kanalnamen. Eigene Datei ohne Abhängigkeiten, damit der Preload (Sandbox) nur diese
 * Konstanten einbündelt und nicht Zod.
 */
export const IPC = {
  getState: 'schichtwechsel:get-state',
  play: 'schichtwechsel:play',
  startGameOnly: 'schichtwechsel:start-game-only',
  retryConnection: 'schichtwechsel:retry-connection',
  redeemInvite: 'schichtwechsel:redeem-invite',
  listVersions: 'schichtwechsel:list-versions',
  restoreVersion: 'schichtwechsel:restore-version',
  getMap: 'schichtwechsel:get-map',
  getSettings: 'schichtwechsel:get-settings',
  updateSettings: 'schichtwechsel:update-settings',
  copySessionCode: 'schichtwechsel:copy-session-code',
  createLinkCode: 'schichtwechsel:create-link-code',
  windowMinimize: 'schichtwechsel:window-minimize',
  windowClose: 'schichtwechsel:window-close',
} as const;

/** Main → Renderer: neuer `AppState` (Push, kein invoke). */
export const STATE_CHANGED_CHANNEL = 'schichtwechsel:state-changed' as const;

export type InvokeChannel = (typeof IPC)[keyof typeof IPC];
