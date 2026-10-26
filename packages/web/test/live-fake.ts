import type { Alert } from '@centinela/shared';
import type { AlertChangeType, LiveHandlers, LiveSource } from '../src/features/live/live-source';

/** A live source driven by the test: open, emit messages, fail. */
export function createFakeLiveSource() {
  const connections: Array<{ handlers: LiveHandlers; closed: boolean }> = [];
  const source: LiveSource = (handlers) => {
    const connection = { handlers, closed: false };
    connections.push(connection);
    return {
      close: () => {
        connection.closed = true;
      },
    };
  };
  const active = () => {
    const connection = connections.filter((c) => !c.closed).at(-1);
    if (!connection) throw new Error('no open live connection');
    return connection.handlers;
  };
  return {
    source,
    connections,
    open: () => active().onOpen(),
    emit: (type: AlertChangeType, alert: Alert | string) =>
      active().onMessage(type, typeof alert === 'string' ? alert : JSON.stringify(alert)),
    fail: () => active().onError(),
  };
}
