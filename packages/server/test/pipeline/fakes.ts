import type { NormalizedEvent, SourceType } from '@centinela/shared';
import type {
  AlertCandidate,
  AlertPublisher,
  Detector,
  EventStore,
  IngestContext,
  Parser,
} from '../../src/pipeline/types.js';

/** Test parser: `<ISO timestamp> <user> <action>`; anything else is rejected. */
export function fakeParser(source: SourceType = 'linux_auth'): Parser {
  return {
    source,
    parse(line: string, ctx: IngestContext) {
      if (line.includes('THROW')) throw new Error('boom');
      const [ts, user, action] = line.split(' ');
      if (
        ts === undefined ||
        user === undefined ||
        action === undefined ||
        Number.isNaN(Date.parse(ts))
      ) {
        return { ok: false, reason: 'not a test line' };
      }
      return {
        ok: true,
        event: {
          ts: new Date(ts).toISOString(),
          source,
          host: ctx.host,
          logsources: [{ product: 'linux', service: 'auth' }],
          category: 'authentication',
          action,
          outcome: 'failure',
          user,
          message: line,
          fields: { 'event.action': action, 'user.name': user, 'host.name': ctx.host },
        },
      };
    },
  };
}

export function recordingStore(): EventStore & { batches: NormalizedEvent[][] } {
  const batches: NormalizedEvent[][] = [];
  return {
    batches,
    insertMany(events) {
      batches.push([...events]);
      return Promise.resolve();
    },
  };
}

/** Emits one candidate per event whose action is `alert`, plus whatever `flush` returns. */
export function actionDetector(onFlush: (watermark: Date) => AlertCandidate[] = () => []) {
  const seen: NormalizedEvent[] = [];
  const watermarks: Date[] = [];
  const detector: Detector = {
    process(event) {
      seen.push(event);
      return event.action === 'alert' ? [candidateFor(event)] : [];
    },
    flush(watermark) {
      watermarks.push(watermark);
      return onFlush(watermark);
    },
  };
  return { detector, seen, watermarks };
}

export function candidateFor(
  event: Pick<NormalizedEvent, 'id' | 'ts' | 'host' | 'user'>,
): AlertCandidate {
  return {
    rule: {
      id: '0f6c3f5e-1d2b-4c3a-9e8f-7a6b5c4d3e2f',
      title: 'Test rule',
      type: 'sigma',
      level: 'medium',
      techniques: ['T1110.001'],
      tactics: ['credential-access'],
      author: 'Test Author',
      url: null,
      license: 'MIT',
    },
    dedupKey: `0f6c3f5e-1d2b-4c3a-9e8f-7a6b5c4d3e2f|${event.host}|${event.user ?? ''}`,
    groupKey: null,
    eventIds: [event.id],
    firstSeen: event.ts,
    lastSeen: event.ts,
    host: event.host,
    entities: { ips: [], users: event.user ? [event.user] : [], hosts: [event.host] },
  };
}

export function recordingPublisher(): AlertPublisher & {
  changes: Parameters<AlertPublisher['publish']>[0][];
} {
  const changes: Parameters<AlertPublisher['publish']>[0][] = [];
  return { changes, publish: (change) => void changes.push(change) };
}

export const ctx: IngestContext = {
  source: 'linux_auth',
  host: 'bastion-01',
  receivedAt: new Date('2026-10-25T12:00:00Z'),
  timezone: 'UTC',
};
