import { alertSchema } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { createMemoryAlertSink } from '../../src/pipeline/memory-sink.js';
import type { AlertCandidate } from '../../src/pipeline/types.js';
import { candidateFor } from './fakes.js';

let counter = 0;
function eventId(): string {
  counter += 1;
  return `01930f6e-8a4b-7c2d-9e1f-${counter.toString(16).padStart(12, '0')}`;
}

function candidate(ts: string, user = 'root'): AlertCandidate {
  return candidateFor({ id: eventId(), ts, host: 'bastion-01', user });
}

describe('in-memory alert sink', () => {
  const now = () => new Date('2026-10-25T12:00:00Z');

  it('creates schema-valid alerts carrying the rule snapshot (author, license, techniques)', async () => {
    const sink = createMemoryAlertSink({ now });
    const { created, updated } = await sink.upsert([candidate('2026-10-21T03:00:00Z')]);
    expect(updated).toEqual([]);
    const alert = alertSchema.parse(created[0]);
    expect(alert).toMatchObject({
      status: 'new',
      count: 1,
      author: 'Test Author',
      license: 'MIT',
      techniques: ['T1110.001'],
      tactics: ['credential-access'],
      createdAt: '2026-10-25T12:00:00.000Z',
    });
  });

  it('folds matches within 15 minutes of lastSeen into the open alert', async () => {
    const sink = createMemoryAlertSink({ now });
    await sink.upsert([candidate('2026-10-21T03:00:00Z')]);
    const later = candidate('2026-10-21T03:15:00Z');
    later.entities = { ips: ['203.0.113.45'], users: ['admin'], hosts: ['bastion-01'] };
    const { created, updated } = await sink.upsert([later]);
    expect(created).toEqual([]);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      count: 2,
      firstSeen: '2026-10-21T03:00:00Z',
      lastSeen: '2026-10-21T03:15:00Z',
      entities: { ips: ['203.0.113.45'], users: ['root', 'admin'], hosts: ['bastion-01'] },
    });
    expect(sink.eventIds(updated[0]?.id ?? '')).toHaveLength(2);
  });

  it('creates a new alert after the suppression window', async () => {
    const sink = createMemoryAlertSink({ now });
    await sink.upsert([candidate('2026-10-21T03:00:00Z')]);
    const { created } = await sink.upsert([candidate('2026-10-21T03:15:00.001Z')]);
    expect(created).toHaveLength(1);
    expect(sink.list()).toHaveLength(2);
  });

  it('never folds into a different dedup key', async () => {
    const sink = createMemoryAlertSink({ now });
    const a = candidate('2026-10-21T03:00:00Z');
    const b = { ...candidate('2026-10-21T03:00:01Z'), dedupKey: 'other|bastion-01|root' };
    const { created } = await sink.upsert([a, b]);
    expect(created).toHaveLength(2);
  });

  it('reports an alert created and updated in the same batch only as created', async () => {
    const sink = createMemoryAlertSink({ now });
    const { created, updated } = await sink.upsert([
      candidate('2026-10-21T03:00:00Z'),
      candidate('2026-10-21T03:01:00Z'),
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]?.count).toBe(2);
    expect(updated).toEqual([]);
  });

  it('links at most 100 events per alert', async () => {
    const sink = createMemoryAlertSink({ now });
    const batch = Array.from({ length: 120 }, (_, i) =>
      candidate(new Date(Date.parse('2026-10-21T03:00:00Z') + i * 1000).toISOString()),
    );
    const { created } = await sink.upsert(batch);
    expect(created[0]?.count).toBe(120);
    expect(sink.eventIds(created[0]?.id ?? '')).toHaveLength(100);
  });
});
