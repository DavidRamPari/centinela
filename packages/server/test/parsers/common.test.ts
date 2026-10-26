import { describe, expect, it } from 'vitest';
import {
  MAX_LINE_LENGTH,
  normalizeIp,
  parsePort,
  sanitizeLine,
  toWellFormed,
  truncate,
} from '../../src/parsers/common.js';
import { createParserRegistry } from '../../src/parsers/index.js';
import {
  parseAccessLogTime,
  parseRfc3164Time,
  parseRfc3339Time,
  zonedTimeToUtc,
} from '../../src/parsers/time.js';

describe('normalizeIp', () => {
  it.each([
    ['203.0.113.45', '203.0.113.45'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['fe80::1%eth0', 'fe80::1'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['::1', '::1'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeIp(raw)).toBe(expected);
  });

  it.each(['', 'scanner.example', '999.1.1.1', '10.1', '0x7f.1', '1.2.3.4.5', 'gggg::1'])(
    'rejects %j',
    (raw) => {
      expect(normalizeIp(raw)).toBeUndefined();
    },
  );
});

describe('parsePort', () => {
  it('accepts 0–65535 and rejects anything else', () => {
    expect(parsePort('22')).toBe(22);
    expect(parsePort('65535')).toBe(65535);
    expect(parsePort('65536')).toBeUndefined();
    expect(parsePort('-1')).toBeUndefined();
    expect(parsePort(undefined)).toBeUndefined();
  });
});

describe('sanitizeLine and truncate', () => {
  it('caps the parsed length and makes the text storable', () => {
    expect(sanitizeLine('x'.repeat(MAX_LINE_LENGTH + 10))).toHaveLength(MAX_LINE_LENGTH);
    expect(sanitizeLine('a\u0000b')).toBe('a�b');
    expect(toWellFormed('a\uDC00b😀')).toBe('a�b😀');
  });

  it('never leaves half a surrogate pair at the cut', () => {
    const text = `${'a'.repeat(9)}😀`;
    expect(truncate(text, 10)).toBe(`${'a'.repeat(9)}�`);
    expect(truncate('short', 10)).toBe('short');
  });
});

describe('time helpers', () => {
  const received = new Date('2026-10-26T12:00:00Z');

  it('converts wall time in a DST zone, including the repeated and skipped hours', () => {
    const t = { year: 2026, month: 7, day: 1, hour: 12, minute: 0, second: 0, millisecond: 0 };
    expect(new Date(zonedTimeToUtc(t, 'Europe/Madrid')).toISOString()).toBe(
      '2026-07-01T10:00:00.000Z',
    );
    expect(new Date(zonedTimeToUtc({ ...t, month: 1 }, 'Europe/Madrid')).toISOString()).toBe(
      '2026-01-01T11:00:00.000Z',
    );
    // 2026-03-29 02:30 does not exist in Madrid (clocks jump 02:00 → 03:00).
    const gap = zonedTimeToUtc({ ...t, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Madrid');
    expect(new Date(gap).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('parses RFC 3164 with year inference', () => {
    expect(new Date(parseRfc3164Time('Oct 25 14:03:12', 'UTC', received) ?? 0).toISOString()).toBe(
      '2026-10-25T14:03:12.000Z',
    );
    expect(parseRfc3164Time('Oct 25 14:03', 'UTC', received)).toBeUndefined();
  });

  it('accepts Feb 29 from a leap year when the inferred year is not one', () => {
    const march2029 = new Date('2029-03-01T00:00:00Z');
    expect(new Date(parseRfc3164Time('Feb 29 10:00:00', 'UTC', march2029) ?? 0).toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    );
  });

  it('parses RFC 3339 variants', () => {
    expect(parseRfc3339Time('2026-10-25T14:03:12.1-05:30', 'UTC')).toBe(
      Date.parse('2026-10-25T19:33:12.100Z'),
    );
    expect(parseRfc3339Time('2026-12-31T23:59:60Z', 'UTC')).toBe(
      Date.parse('2026-12-31T23:59:59Z'),
    );
    expect(parseRfc3339Time('2026-10-25 14:03:12Z', 'UTC')).toBeUndefined();
  });

  it('parses access-log time with its offset', () => {
    expect(parseAccessLogTime('25/Oct/2026:14:03:12 +0530')).toBe(
      Date.parse('2026-10-25T08:33:12Z'),
    );
    expect(parseAccessLogTime('25/Oct/2026:14:03:12 +2400')).toBeUndefined();
  });
});

describe('parser registry', () => {
  it('registers the S1 parsers and the S5 sysmon parser', () => {
    expect([...createParserRegistry().keys()].sort()).toEqual([
      'apache_access',
      'linux_auth',
      'nginx_access',
      'sysmon',
    ]);
  });
});
