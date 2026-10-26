import { EventEmitter } from 'node:events';
import type { Alert } from '@centinela/shared';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { createSseHub } from '../../src/realtime/hub.js';

/** Just enough of an Express response for the hub; records what is written. */
class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  headers: Record<string, string> = {};
  statusCode = 0;
  writableLength = 0;
  destroyed = false;
  ended = false;
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  set(headers: Record<string, string>) {
    Object.assign(this.headers, headers);
    return this;
  }
  flushHeaders() {}
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
  end() {
    this.ended = true;
    this.emit('close');
  }
}

function connect(hub: ReturnType<typeof createSseHub>) {
  const res = new FakeResponse();
  const attached = hub.attach(res as unknown as Response);
  return { res, attached };
}

const alert: Alert = {
  id: '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f',
  ruleId: '6c1f0b6e-5f5a-4e61-9a0e-1f2b3c4d5e6f',
  ruleTitle: 'SSH brute force\n\nevent: alert.created\ndata: {"forged":true}',
  ruleType: 'correlation',
  level: 'high',
  status: 'new',
  resolution: null,
  note: 'line one\r\nline two\rdata: x',
  dedupKey: 'k',
  groupKey: null,
  host: 'bastion-01',
  techniques: ['T1110.001'],
  tactics: ['credential-access'],
  entities: { ips: [], users: ['<script>'], hosts: [] },
  firstSeen: '2026-10-21T03:12:00.000Z',
  lastSeen: '2026-10-21T03:16:00.000Z',
  count: 1,
  author: null,
  ruleUrl: null,
  license: 'MIT',
  createdAt: '2026-10-21T03:16:00.000Z',
  updatedAt: '2026-10-21T03:16:00.000Z',
};

describe('SSE hub', () => {
  it('opens an event stream and writes each change as one event', () => {
    const hub = createSseHub();
    const { res, attached } = connect(hub);
    expect(attached).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/^text\/event-stream/);
    expect(res.headers['Cache-Control']).toContain('no-cache');
    hub.publish({ type: 'alert.updated', alert });
    const event = res.chunks.at(-1) ?? '';
    expect(event.startsWith('event: alert.updated\ndata: ')).toBe(true);
    hub.close();
  });

  it('keeps attacker-controlled text inside one data line', () => {
    const hub = createSseHub();
    const { res } = connect(hub);
    hub.publish({ type: 'alert.created', alert });
    const event = res.chunks.at(-1) ?? '';
    const lines = event.split(/\r\n|\r|\n/);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('event: alert.created');
    expect(JSON.parse(lines[1]?.replace(/^data: /, '') ?? '')).toEqual(alert);
    expect(lines.slice(2)).toEqual(['', '']);
    hub.close();
  });

  it('refuses clients beyond the limit and after close', () => {
    const hub = createSseHub({ maxClients: 2 });
    expect(connect(hub).attached).toBe(true);
    expect(connect(hub).attached).toBe(true);
    const third = connect(hub);
    expect(third.attached).toBe(false);
    expect(third.res.chunks).toEqual([]);
    hub.close();
    expect(hub.size).toBe(0);
    expect(connect(hub).attached).toBe(false);
  });

  it('forgets a client when its connection closes', () => {
    const hub = createSseHub({ maxClients: 1 });
    const first = connect(hub);
    first.res.emit('close');
    expect(hub.size).toBe(0);
    expect(connect(hub).attached).toBe(true);
    hub.close();
  });

  it('drops a client whose unsent output exceeds the limit', () => {
    const hub = createSseHub({ maxBufferedBytes: 1000 });
    const slow = connect(hub);
    const fast = connect(hub);
    slow.res.writableLength = 1001;
    hub.publish({ type: 'alert.created', alert });
    expect(slow.res.destroyed).toBe(true);
    expect(fast.res.destroyed).toBe(false);
    expect(hub.size).toBe(1);
    hub.close();
  });

  it('sends a ping comment on the interval', async () => {
    const hub = createSseHub({ pingIntervalMs: 10 });
    const { res } = connect(hub);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(res.chunks).toContain(': ping\n\n');
    hub.close();
  });

  it('ends every stream on close', () => {
    const hub = createSseHub();
    const a = connect(hub);
    const b = connect(hub);
    hub.close();
    expect([a.res.ended, b.res.ended]).toEqual([true, true]);
  });
});
