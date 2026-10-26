import { describe, expect, it } from 'vitest';
import { createFormatters, localeFor } from '../src/lib/format';
import { safeHref, techniqueUrl } from '../src/lib/links';
import { applyParamUpdates, readListParam, readTextParam } from '../src/lib/search-params';
import {
  bucketFor,
  fillBuckets,
  rangeQuery,
  readTimeRange,
  writeTimeRange,
} from '../src/lib/time-range';

const NOW = Date.parse('2026-10-25T12:34:56.789Z');

describe('time range', () => {
  it('defaults to the last 24 hours and ignores invalid values', () => {
    expect(readTimeRange(new URLSearchParams())).toEqual({ kind: 'preset', preset: '24h' });
    expect(readTimeRange(new URLSearchParams('range=99y'))).toEqual({
      kind: 'preset',
      preset: '24h',
    });
    expect(readTimeRange(new URLSearchParams('from=yesterday'))).toEqual({
      kind: 'preset',
      preset: '24h',
    });
  });

  it('reads custom ranges and drops a `to` before `from`', () => {
    expect(
      readTimeRange(new URLSearchParams('from=2026-10-20T00:00:00Z&to=2026-10-21T00:00:00Z')),
    ).toEqual({
      kind: 'custom',
      from: '2026-10-20T00:00:00Z',
      to: '2026-10-21T00:00:00Z',
    });
    expect(
      readTimeRange(new URLSearchParams('from=2026-10-20T00:00:00Z&to=2026-10-19T00:00:00Z')),
    ).toEqual({
      kind: 'custom',
      from: '2026-10-20T00:00:00Z',
      to: undefined,
    });
  });

  it('sends only `from` for presets, floored to the minute', () => {
    expect(rangeQuery({ kind: 'preset', preset: '1h' }, NOW)).toEqual({
      from: '2026-10-25T11:34:00.000Z',
    });
    expect(rangeQuery({ kind: 'custom', from: 'a', to: 'b' }, NOW)).toEqual({ from: 'a', to: 'b' });
  });

  it('writes ranges back without the default preset', () => {
    const base = new URLSearchParams('level=high&range=7d');
    expect(writeTimeRange(base, { kind: 'preset', preset: '24h' }).toString()).toBe('level=high');
    expect(writeTimeRange(base, { kind: 'preset', preset: '30d' }).toString()).toBe(
      'level=high&range=30d',
    );
    expect(
      writeTimeRange(base, {
        kind: 'custom',
        from: '2026-10-20T00:00:00.000Z',
        to: undefined,
      }).toString(),
    ).toBe('level=high&from=2026-10-20T00%3A00%3A00.000Z');
  });

  it('picks chart buckets and fills gaps with zeros', () => {
    expect(bucketFor({ kind: 'preset', preset: '1h' })).toBe('5m');
    expect(bucketFor({ kind: 'preset', preset: '24h' })).toBe('1h');
    expect(bucketFor({ kind: 'preset', preset: '30d' })).toBe('1d');
    expect(
      fillBuckets(
        [{ t: '2026-10-25T02:00:00.000Z', count: 3 }],
        '2026-10-25T00:30:00Z',
        '2026-10-25T03:10:00Z',
        '1h',
      ),
    ).toEqual([
      { t: '2026-10-25T00:00:00.000Z', count: 0 },
      { t: '2026-10-25T01:00:00.000Z', count: 0 },
      { t: '2026-10-25T02:00:00.000Z', count: 3 },
      { t: '2026-10-25T03:00:00.000Z', count: 0 },
    ]);
  });
});

describe('formatting', () => {
  it('uses Latin American Spanish or US English', () => {
    expect(localeFor('es')).toBe('es-419');
    expect(localeFor('en')).toBe('en-US');
    expect(createFormatters('en-US').number(12345)).toBe('12,345');
    expect(createFormatters('es-419').number(12345)).toBe('12,345');
    expect(createFormatters('en-US').durationMs(1530)).toBe('1.53 s');
    expect(createFormatters('es-419').durationMs(1530)).toBe('1.53 s');
    expect(createFormatters('en-US').bytes(5_242_880)).toBe('5.2 MB');
  });

  it('formats dates for the locale', () => {
    const iso = '2026-10-25T12:00:00Z';
    expect(createFormatters('en-US').dateTime(iso)).toMatch(/Oct/);
    expect(createFormatters('es-419').dateTime(iso)).toMatch(/oct/);
  });
});

describe('URL filters and links', () => {
  it('keeps only allowed list values and bounded text', () => {
    const params = new URLSearchParams(
      `level=high,bogus,critical&host=${'a'.repeat(300)}&q=%20%20`,
    );
    expect(readListParam(params, 'level', ['low', 'high', 'critical'] as const)).toEqual([
      'high',
      'critical',
    ]);
    expect(readTextParam(params, 'host')).toHaveLength(256);
    expect(readTextParam(params, 'q')).toBeUndefined();
    expect(
      applyParamUpdates(params, {
        level: [],
        host: undefined,
        q: 'x',
        status: ['new', 'closed'],
      }).toString(),
    ).toBe('q=x&status=new%2Cclosed');
  });

  it('only turns http(s) URLs into links', () => {
    expect(safeHref('https://github.com/SigmaHQ/sigma')).toBe('https://github.com/SigmaHQ/sigma');
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,<script>')).toBeUndefined();
    expect(safeHref('not a url')).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
    expect(techniqueUrl('t1110.001')).toBe('https://attack.mitre.org/techniques/T1110/001/');
  });
});
