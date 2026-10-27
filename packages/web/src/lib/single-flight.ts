/**
 * One submit at a time (S7b-17). `run` starts the task unless the previous one is still
 * running, and `busy` turns the button into its working state from the first click.
 *
 * A mutation's own `isPending` is not enough: TanStack Query tells components about it on a
 * timer, after the click handler, and some submits do work before the request starts (the
 * upload reads the file first). Two clicks or two Enter presses in that gap would send the
 * request twice; the ref closes it.
 */
import { useCallback, useRef, useState } from 'react';

export function useSingleFlight() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback((task: () => Promise<unknown>): boolean => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    // The task reports its own failure (mutation state, callbacks); here it only ends the flight.
    void task()
      .catch(() => undefined)
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
    return true;
  }, []);
  return { busy, run };
}
