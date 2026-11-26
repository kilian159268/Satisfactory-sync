import { useCallback, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

/**
 * Misst ein Element per ResizeObserver. Gibt einen Callback-Ref und die Größe zurück
 * (null, solange nicht gemessen oder ResizeObserver fehlt, z. B. in jsdom).
 */
export function useElementSize(): [(node: Element | null) => void, Size | null] {
  const [size, setSize] = useState<Size | null>(null);
  const ref = useCallback((node: Element | null) => {
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect !== undefined && rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, size];
}
