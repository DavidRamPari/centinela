import {
  ALERT_STATUSES,
  LEVELS,
  SOURCE_TYPES,
  alertSchema,
  normalizedEventSchema,
  ruleMetaSchema,
} from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { HOSTILE, createMockDb, sigmaSource } from '../src/mocks/fixtures/build';
import { SIGMAHQ_FIXTURE_RULES } from '../src/mocks/fixtures/sigma-rules';
import { uuidv7, mulberry32 } from '../src/mocks/prng';
import { attackMatrix, decodeCursor, encodeCursor, listEvents } from '../src/mocks/queries';

const NOW = Date.parse('2026-10-25T12:00:00Z');

describe('mock fixtures', () => {
  const db = createMockDb({ now: NOW });

  it('follow the shared schemas', () => {
    for (const event of db.events) expect(normalizedEventSchema.parse(event)).toEqual(event);
    for (const alert of db.alerts) expect(alertSchema.parse(alert)).toEqual(alert);
    for (const rule of db.rules) expect(ruleMetaSchema.parse(rule)).toEqual(rule);
  });

  it('have at least 200 events and 30 alerts across levels, statuses and sources', () => {
    expect(db.events.length).toBeGreaterThanOrEqual(200);
    expect(db.alerts.length).toBeGreaterThanOrEqual(30);
    expect(new Set(db.alerts.map((a) => a.level))).toEqual(new Set(LEVELS));
    expect(new Set(db.alerts.map((a) => a.status))).toEqual(new Set(ALERT_STATUSES));
    expect(new Set(db.events.map((e) => e.source))).toEqual(new Set(SOURCE_TYPES));
    expect(new Set(db.alerts.flatMap((a) => a.techniques)).size).toBeGreaterThanOrEqual(15);
    expect(new Set(db.alerts.map((a) => a.ruleType))).toEqual(new Set(['sigma', 'correlation']));
  });

  it('contain hostile strings and a line cut at 8,192 characters', () => {
    const messages = db.events.map((e) => e.message).join('\n');
    expect(messages).toContain(HOSTILE.script);
    expect(messages).toContain(HOSTILE.sqli);
    expect(messages).toContain(HOSTILE.img);
    expect(db.events.some((e) => e.message.length === 8192)).toBe(true);
    expect(db.alerts.some((a) => a.entities.users.includes(HOSTILE.img))).toBe(true);
  });

  it('link every alert to existing events and rules', () => {
    for (const alert of db.alerts) {
      const ids = db.alertEvents.get(alert.id) ?? [];
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(db.events.some((e) => e.id === id)).toBe(true);
      expect(db.rules.some((r) => r.id === alert.ruleId)).toBe(true);
    }
  });

  it('carry DRL attribution for SigmaHQ rules and MIT for Centinela rules', () => {
    for (const rule of db.rules) {
      if (rule.origin === 'sigmahq') {
        expect(rule.license).toBe('DRL-1.1');
        expect(rule.author).toBeTruthy();
        expect(rule.url).toMatch(
          /^https:\/\/github\.com\/SigmaHQ\/sigma\/blob\/[0-9a-f]{40}\/rules\//,
        );
      } else {
        expect(rule.license).toBe('MIT');
        expect(rule.author).toBe('DavidRamPari');
      }
    }
    const sigmaAlert = db.alerts.find((a) => a.license === 'DRL-1.1');
    expect(sigmaAlert?.author).toBeTruthy();
    expect(sigmaAlert?.ruleUrl).toBeTruthy();
  });

  it('match the vendored SigmaHQ rule files they were extracted from', () => {
    for (const rule of SIGMAHQ_FIXTURE_RULES) {
      const source = sigmaSource(rule.path);
      expect(source, rule.path).toBeDefined();
      expect(source).toContain(`id: ${rule.id}`);
      expect(source).toContain(`title: ${rule.title}`);
      expect(source).toContain(`level: ${rule.level}`);
    }
  });

  it('are deterministic for a seed and differ between seeds', () => {
    const again = createMockDb({ now: NOW });
    expect(JSON.stringify(again.events)).toBe(JSON.stringify(db.events));
    expect(JSON.stringify(again.alerts)).toBe(JSON.stringify(db.alerts));
    const other = createMockDb({ now: NOW, seed: 7 });
    expect(JSON.stringify(other.events)).not.toBe(JSON.stringify(db.events));
  });

  it('generate valid UUIDv7 ids that sort by time', () => {
    const rng = mulberry32(1);
    const a = uuidv7(NOW, rng);
    const b = uuidv7(NOW + 1000, rng);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('mock queries', () => {
  const db = createMockDb({ now: NOW });
  const from = new Date(NOW - 7 * 24 * 3600_000).toISOString();
  const to = new Date(NOW).toISOString();

  it('page events with keyset cursors without gaps or duplicates', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = listEvents(db, { from, to, limit: 37, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(db.events.map((e) => e.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('round-trips cursors as base64url', () => {
    const cursor = encodeCursor('2026-10-25T12:00:00.000Z|abc');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toBe('2026-10-25T12:00:00.000Z|abc');
  });

  it('builds an ATT&CK matrix with alert and rule counts', () => {
    const matrix = attackMatrix(db, { from, to });
    const all = matrix.tactics.flatMap((t) => t.techniques);
    expect(matrix.tactics.length).toBeGreaterThanOrEqual(12);
    expect(all.find((t) => t.id === 'T1110.001')?.alerts).toBeGreaterThan(0);
    expect(all.find((t) => t.id === 'T1190')?.rules).toBeGreaterThan(0);
  });
});
