import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { decodeBody, mergeRejections, splitLines } from '../../src/ingest/body.js';
import { readLines } from '../../src/ingest/lines.js';
import type { IngestSummary } from '../../src/pipeline/types.js';

describe('splitLines', () => {
  it('splits on newlines and ignores one trailing newline', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb')).toEqual(['a\r', 'b']);
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
  });
});

describe('decodeBody', () => {
  it('passes text lines through', () => {
    expect(decodeBody('x\ny', 'text')).toEqual({ lines: ['x', 'y'], rejections: [] });
  });

  it('decodes NDJSON strings, message objects and other objects', () => {
    const body = [
      '"Oct 25 14:03:12 h sshd[1]: x"',
      '{"message":"line two","extra":1}',
      '{"Event":{"System":{"EventID":1}}}',
      '',
      '"multi\\nline"',
    ].join('\n');
    expect(decodeBody(body, 'ndjson')).toEqual({
      lines: [
        'Oct 25 14:03:12 h sshd[1]: x',
        'line two',
        '{"Event":{"System":{"EventID":1}}}',
        '',
        'multi line',
      ],
      rejections: [],
    });
  });

  it('rejects invalid NDJSON lines but keeps line numbers', () => {
    const decoded = decodeBody('"ok"\nnot json\n42\n[1]\nnull\n"   "\n"ok"', 'ndjson');
    expect(decoded.lines).toEqual(['ok', '', '', '', '', '', 'ok']);
    expect(decoded.rejections.map((r) => r.line)).toEqual([2, 3, 4, 5, 6]);
    expect(decoded.rejections.every((r) => r.reason === 'invalid NDJSON line')).toBe(true);
  });
});

describe('mergeRejections', () => {
  const summary: IngestSummary = {
    accepted: 1,
    rejected: 2,
    rejections: [
      { line: 1, reason: 'a' },
      { line: 5, reason: 'b' },
    ],
    alertsCreated: 0,
    alertsUpdated: 0,
    durationMs: 1,
  };

  it('adds counts and keeps samples in line order, capped', () => {
    const merged = mergeRejections(summary, [{ line: 3, reason: 'invalid NDJSON line' }], 2);
    expect(merged.rejected).toBe(3);
    expect(merged.rejections).toEqual([
      { line: 1, reason: 'a' },
      { line: 3, reason: 'invalid NDJSON line' },
    ]);
  });

  it('returns the summary unchanged without extra rejections', () => {
    expect(mergeRejections(summary, [], 20)).toBe(summary);
  });
});

async function collect(chunks: Array<Buffer | string>, max?: number): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(Readable.from(chunks), max)) out.push(line);
  return out;
}

describe('readLines', () => {
  it('reassembles lines split across chunks', async () => {
    expect(await collect(['ab', 'c\nde', 'f\n', 'g'])).toEqual(['abc', 'def', 'g']);
  });

  it('keeps empty lines and drops nothing at the end', async () => {
    expect(await collect(['a\n\nb\n'])).toEqual(['a', '', 'b']);
  });

  it('decodes UTF-8 characters split across chunks', async () => {
    const bytes = Buffer.from('ñandú\n', 'utf8');
    expect(await collect([bytes.subarray(0, 2), bytes.subarray(2, 5), bytes.subarray(5)])).toEqual([
      'ñandú',
    ]);
  });

  it('caps very long lines without buffering them', async () => {
    const lines = await collect(['x'.repeat(10), 'y'.repeat(10), '\nnext\n'], 15);
    expect(lines).toEqual([`${'x'.repeat(10)}${'y'.repeat(5)}`, 'next']);
  });
});
