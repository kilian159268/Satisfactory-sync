import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import type { AppState, SchichtwechselApi } from '../../src/shared/ipc';

describe('App (Platzhalter)', () => {
  it('zeigt die Phase aus getState', async () => {
    const state = { phase: 'bereit' } as AppState;
    const api = {
      getState: vi.fn(() => Promise.resolve(state)),
      onState: vi.fn(() => () => undefined),
    } as unknown as SchichtwechselApi;
    Object.defineProperty(window, 'schichtwechsel', { value: api, configurable: true });

    render(<App />);
    expect(await screen.findByText('bereit')).toBeInTheDocument();
  });
});
