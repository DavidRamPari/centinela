/**
 * Server-Sent Events hub for `GET /api/stream` (ARCHITECTURE §10). It is the pipeline's
 * `AlertPublisher`: every alert change is written to every connected client as
 *
 *   event: alert.created | alert.updated
 *   data: <the Alert as JSON>
 *
 * plus a `: ping` comment every 25 seconds so proxies keep idle streams open. The hub
 * holds at most `maxClients` streams and drops a client whose unsent output grows past
 * `maxBufferedBytes` (a slow or stalled reader must not make the server buffer without
 * bound). `JSON.stringify` escapes line breaks inside strings, so attacker-controlled
 * text in an alert can never end the `data:` line or inject an SSE field.
 */
import type { Response } from 'express';
import type { Logger } from '../logger.js';
import type { AlertPublisher } from '../pipeline/types.js';

export const DEFAULT_MAX_CLIENTS = 50;
export const DEFAULT_PING_INTERVAL_MS = 25_000;
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

export interface SseHubOptions {
  maxClients?: number;
  pingIntervalMs?: number;
  maxBufferedBytes?: number;
  logger?: Logger;
}

export interface SseHub extends AlertPublisher {
  /**
   * Turn the response into an event stream and register it. Returns false (and writes
   * nothing) when the hub is full or closed.
   */
  attach(res: Response): boolean;
  /** Connected clients. */
  readonly size: number;
  /** End every stream and stop accepting new ones (shutdown). */
  close(): void;
}

export function createSseHub(options: SseHubOptions = {}): SseHub {
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const clients = new Set<Response>();
  let pinger: NodeJS.Timeout | undefined;
  let closed = false;

  function remove(res: Response): void {
    clients.delete(res);
    if (clients.size === 0 && pinger) {
      clearInterval(pinger);
      pinger = undefined;
    }
  }

  /** Write to one client, dropping it when it cannot keep up. */
  function send(res: Response, chunk: string): void {
    if (res.writableLength > maxBufferedBytes) {
      options.logger?.warn('dropping a slow live-stream client');
      remove(res);
      res.destroy();
      return;
    }
    res.write(chunk);
  }

  function broadcast(chunk: string): void {
    for (const res of [...clients]) send(res, chunk);
  }

  return {
    get size() {
      return clients.size;
    },

    attach(res) {
      if (closed || clients.size >= maxClients) return false;
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // nginx: do not buffer this response.
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.write(': connected\n\n');
      clients.add(res);
      pinger ??= setInterval(() => broadcast(': ping\n\n'), pingIntervalMs).unref();
      // `close` fires when the client goes away or the stream is ended or destroyed.
      res.on('close', () => remove(res));
      return true;
    },

    publish({ type, alert }) {
      if (clients.size === 0) return;
      broadcast(`event: ${type}\ndata: ${JSON.stringify(alert)}\n\n`);
    },

    close() {
      closed = true;
      for (const res of [...clients]) {
        remove(res);
        res.end();
      }
    },
  };
}
