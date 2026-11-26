import { act, fireEvent } from '@testing-library/react';

/**
 * Schlanker Ersatz für @testing-library/user-event (nicht installiert): Klick und Eingabe
 * innerhalb von act(), danach laufen anstehende Promises (IPC-Antworten) durch.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

export const userEvent = {
  async click(element: Element): Promise<void> {
    await act(async () => {
      fireEvent.click(element);
      await flush();
    });
  },
  async type(element: Element, text: string): Promise<void> {
    await act(async () => {
      const input = element as HTMLInputElement;
      fireEvent.change(input, { target: { value: input.value + text } });
      await flush();
    });
  },
  async clearAndType(element: Element, text: string): Promise<void> {
    await act(async () => {
      fireEvent.change(element, { target: { value: text } });
      await flush();
    });
  },
};
