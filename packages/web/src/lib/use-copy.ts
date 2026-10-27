/**
 * Copy to the clipboard with a short confirmation (S7b-17): `state` is `copied` (or
 * `failed`, when the browser refuses) for `COPIED_MS`, then back to `idle`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export const COPIED_MS = 1500;

export type CopyState = 'idle' | 'copied' | 'failed';

export function useCopy() {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (value: string) => {
    let next: CopyState = 'copied';
    try {
      // Undefined outside a secure context (plain http on another host).
      if (!('clipboard' in navigator)) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
    } catch {
      next = 'failed';
    }
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPIED_MS);
  }, []);

  return { state, copy };
}
