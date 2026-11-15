import type { NormalizedEvent } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import {
  compareOrderKeys,
  orderKeyOf,
  ReorderBuffer,
  type Buffered,
} from '../../src/pipeline/reorder.js';
import { seeded } from './live.js';

const T0 = Date.parse('2026-10-25T10:00:00Z');

function item(
  seconds: number,
  id: string,
  host = 'web-01',
  source: NormalizedEvent['source'] = 'linux_auth',
  call = 1,
): Buffered {
  const time = T0 + seconds * 1000;
  return {
    time,
    call,
    event: {
      id,
      ts: new Date(time).toISOString(),
      ingestedAt: '2026-10-25T12:00:00.000Z',
      source,
      host,
      logsources: [],
      category: 'authentication',
      action: 'login',
      outcome: 'success',
      message: id,
      fields: {},
    },
  };
}

const ids = (items: readonly Buffered[]) => items.map((i) => i.event.id);

describe('order key', () => {
  it('orders by detection time, then host, then source, then id', () => {
    const sorted = [
      item(1, 'b', 'web-02'),
      item(1, 'a', 'web-01', 'nginx_access'),
      item(1, 'c', 'web-01', 'linux_auth'),
      item(1, 'a', 'web-01', 'linux_auth'),
      item(0, 'z', 'zzz'),
    ].sort((x, y) => compareOrderKeys(orderKeyOf(x), orderKeyOf(y)));
    expect(
      sorted.map((i) => `${i.time - T0}/${i.event.host}/${i.event.source}/${i.event.id}`),
    ).toEqual([
      '0/zzz/linux_auth/z',
      '1000/web-01/linux_auth/a',
      '1000/web-01/linux_auth/c',
      '1000/web-01/nginx_access/a',
      '1000/web-02/linux_auth/b',
    ]);
  });

  it('compares text by code unit, not by locale', () => {
    // A locale-aware comparison would put "a" before "B".
    expect(
      compareOrderKeys(orderKeyOf(item(0, 'x', 'B')), orderKeyOf(item(0, 'x', 'a'))),
    ).toBeLessThan(0);
  });
});

describe('ReorderBuffer', () => {
  it('holds events inside the window and releases what the horizon passed, in order', () => {
    const buffer = new ReorderBuffer({ windowMs: 10_000, maxEvents: 1000 });
    expect(buffer.push([item(5, 'a5'), item(3, 'a3'), item(8, 'a8')])).toEqual({
      late: [],
      released: [],
      early: 0,
    });
    expect(buffer.size).toBe(3);
    // Newest is now 14 s: the horizon is 4 s.
    const second = buffer.push([item(14, 'b14'), item(4, 'b4', 'web-02')]);
    expect(ids(second.released)).toEqual(['a3', 'b4']);
    expect(second.late).toEqual([]);
    expect(buffer.size).toBe(3);
    expect(buffer.newest).toBe(T0 + 14_000);
    expect(buffer.lastReleased).toMatchObject({ id: 'b4', host: 'web-02' });
  });

  it('interleaves two streams by time whatever order their batches arrive in', () => {
    const a = [0, 2, 4, 6, 8].map((s) => item(s, `a${s}`, 'web-01'));
    const b = [1, 3, 5, 7, 9].map((s) => item(s, `b${s}`, 'web-02'));
    for (const batches of [
      [a, b],
      [b, a],
    ]) {
      const buffer = new ReorderBuffer({ windowMs: 10_000, maxEvents: 1000 });
      for (const batch of batches) expect(buffer.push(batch).released).toEqual([]);
      expect(ids(buffer.releaseAll())).toEqual([
        'a0',
        'b1',
        'a2',
        'b3',
        'a4',
        'b5',
        'a6',
        'b7',
        'a8',
        'b9',
      ]);
    }
  });

  it('hands out an event that arrives behind the last released one as late, in order', () => {
    const buffer = new ReorderBuffer({ windowMs: 2_000, maxEvents: 1000 });
    expect(ids(buffer.push([item(0, 'x0'), item(10, 'x10')]).released)).toEqual(['x0']);
    expect(ids(buffer.push([item(20, 'x20')]).released)).toEqual(['x10']);
    // 10 s is the last released time; older events can no longer be put in order.
    const result = buffer.push([item(7, 'late7'), item(5, 'late5'), item(15, 'ok15')]);
    expect(ids(result.late)).toEqual(['late5', 'late7']);
    expect(ids(result.released)).toEqual(['ok15']);
    // Late events do not move the last released key backwards.
    expect(buffer.lastReleased?.id).toBe('ok15');
  });

  it('decides lateness with the whole key, not only the time', () => {
    const buffer = new ReorderBuffer({ windowMs: 0, maxEvents: 1000 });
    buffer.push([item(1, 'm', 'web-05')]);
    const result = buffer.push([item(1, 'm', 'web-01'), item(1, 'm', 'web-09')]);
    expect(result.late.map((i) => i.event.host)).toEqual(['web-01']);
    expect(result.released.map((i) => i.event.host)).toEqual(['web-09']);
  });

  it('with a window of zero evaluates on arrival', () => {
    const buffer = new ReorderBuffer({ windowMs: 0, maxEvents: 1000 });
    expect(ids(buffer.push([item(3, 'c'), item(1, 'a'), item(2, 'b')]).released)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(buffer.size).toBe(0);
  });

  it('with an infinite window holds everything until it is drained', () => {
    const buffer = new ReorderBuffer({ windowMs: Number.POSITIVE_INFINITY, maxEvents: 1000 });
    expect(buffer.push([item(0, 'a'), item(86_400, 'b')]).released).toEqual([]);
    expect(ids(buffer.releaseAll())).toEqual(['a', 'b']);
  });

  it('releases through a time on request (ack=evaluated)', () => {
    const buffer = new ReorderBuffer({ windowMs: 60_000, maxEvents: 1000 });
    buffer.push([item(1, 'a'), item(2, 'b'), item(3, 'c')]);
    expect(ids(buffer.releaseThrough(T0 + 2_000))).toEqual(['a', 'b']);
    expect(buffer.size).toBe(1);
    expect(buffer.releaseThrough(T0 + 2_000)).toEqual([]);
  });

  it('never holds more than its bound: the oldest leave early and are counted', () => {
    const buffer = new ReorderBuffer({ windowMs: 60_000, maxEvents: 3 });
    const result = buffer.push([1, 2, 3, 4, 5].map((s) => item(s, `e${s}`)));
    expect(ids(result.released)).toEqual(['e1', 'e2']);
    expect(result.early).toBe(2);
    expect(buffer.size).toBe(3);
    // What left early is released: an older event arriving now is late.
    expect(ids(buffer.push([item(1.5, 'old')]).late)).toEqual(['old']);
  });

  it('counts the waiting events of one ingest call', () => {
    const buffer = new ReorderBuffer({ windowMs: 60_000, maxEvents: 1000 });
    buffer.push([item(1, 'a', 'web-01', 'linux_auth', 1), item(2, 'b', 'web-01', 'linux_auth', 1)]);
    buffer.push([item(3, 'c', 'web-01', 'linux_auth', 2)]);
    expect(buffer.countOfCall(1)).toBe(2);
    expect(buffer.countOfCall(2)).toBe(1);
    buffer.releaseThrough(T0 + 1_000);
    expect(buffer.countOfCall(1)).toBe(1);
  });

  it('survives a snapshot and restore with the same order and the same lateness', () => {
    const buffer = new ReorderBuffer({ windowMs: 5_000, maxEvents: 1000 });
    const all = [item(0, 'a'), item(6, 'b'), item(7, 'c'), item(9, 'd')];
    buffer.push(all);
    const snapshot = buffer.snapshot();
    expect(snapshot).toEqual({
      newest: T0 + 9_000,
      lastReleased: { time: T0, host: 'web-01', source: 'linux_auth', id: 'a' },
      events: [
        { id: 'b', time: T0 + 6_000 },
        { id: 'c', time: T0 + 7_000 },
        { id: 'd', time: T0 + 9_000 },
      ],
    });

    const byId = new Map(all.map((i) => [i.event.id, i]));
    const restored = new ReorderBuffer({ windowMs: 5_000, maxEvents: 1000 });
    restored.restore({
      newest: snapshot.newest,
      lastReleased: snapshot.lastReleased,
      items: snapshot.events.flatMap((e) => byId.get(e.id) ?? []),
    });
    for (const b of [buffer, restored]) {
      const result = b.push([item(12, 'e'), item(-1, 'too-old')]);
      expect(ids(result.late)).toEqual(['too-old']);
      expect(ids(result.released)).toEqual(['b', 'c']);
      expect(ids(b.releaseAll())).toEqual(['d', 'e']);
    }
  });

  it('always releases in order: 20,000 events in random batches', () => {
    const random = seeded(7);
    const buffer = new ReorderBuffer({ windowMs: 30_000, maxEvents: 5_000 });
    const out: Buffered[] = [];
    let late = 0;
    let n = 0;
    for (let batch = 0; batch < 200; batch += 1) {
      const base = batch * 2; // event time moves forward two seconds per batch
      const items = Array.from({ length: 100 }, () => {
        n += 1;
        return item(base + random() * 20, `e${String(n).padStart(6, '0')}`, `h${n % 7}`);
      });
      const result = buffer.push(items);
      late += result.late.length;
      out.push(...result.released);
    }
    out.push(...buffer.releaseAll());
    expect(late).toBe(0);
    expect(out).toHaveLength(20_000);
    for (let i = 1; i < out.length; i += 1) {
      const previous = out[i - 1];
      const current = out[i];
      if (previous === undefined || current === undefined) throw new Error('missing item');
      expect(compareOrderKeys(orderKeyOf(previous), orderKeyOf(current))).toBeLessThan(0);
    }
  });
});
