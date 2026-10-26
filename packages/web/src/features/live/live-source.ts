/**
 * Live alert changes (ARCHITECTURE §10). A `LiveSource` opens one connection and reports
 * what happens on it; reconnection with backoff lives in `useLiveUpdates`. The browser
 * implementation uses `EventSource` on `/api/stream`; the mocks and tests provide fakes.
 */
import { ALERT_CHANGE_TYPES } from '@centinela/shared';

export type AlertChangeType = (typeof ALERT_CHANGE_TYPES)[number];

export interface LiveHandlers {
  onOpen: () => void;
  /** `data` is the raw SSE data: the changed `Alert` as JSON (untrusted, parsed by the caller). */
  onMessage: (type: AlertChangeType, data: string) => void;
  onError: () => void;
}

export interface LiveConnection {
  close: () => void;
}

export type LiveSource = (handlers: LiveHandlers) => LiveConnection;

export const STREAM_URL = '/api/stream';

export function eventSourceLive(url: string = STREAM_URL): LiveSource {
  return (handlers) => {
    const source = new EventSource(url);
    source.onopen = () => handlers.onOpen();
    // Close on error: useLiveUpdates reconnects with its own backoff.
    source.onerror = () => handlers.onError();
    for (const type of ALERT_CHANGE_TYPES) {
      source.addEventListener(type, (event) => {
        if (typeof event.data === 'string') handlers.onMessage(type, event.data);
      });
    }
    return { close: () => source.close() };
  };
}

/** No live updates (environments without EventSource, such as jsdom). */
export const noLiveSource: LiveSource = () => ({ close: () => undefined });

export function defaultLiveSource(): LiveSource {
  return typeof EventSource === 'undefined' ? noLiveSource : eventSourceLive();
}

/** Reconnect delay after `attempt` consecutive failures: 1 s, 2 s, 4 s … capped at 30 s. */
export function backoffDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}
