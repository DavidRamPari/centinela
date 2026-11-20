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
    expect(decodeBody('x\ny', 'text', 'line')).toEqual({ lines: ['x', 'y'], rejections: [] });
    expect(decodeBody('{"a":1}', 'text', 'object')).toEqual({
      lines: ['{"a":1}'],
      rejections: [],
    });
  });

  // ARCHITECTURE §9: what each JSON value becomes for a `line` and an `object` source.
  const SYSMON = '{"EventID":1,"Computer":"ws-0142","Image":"C:\\\\Windows\\\\cmd.exe"}';
  const WRAPPED = '{"message":"Process Create: ...","EventID":1,"Computer":"ws-0142"}';
  it.each([
    [
      'a string',
      '"Oct 25 14:03:12 h sshd[1]: x"',
      'Oct 25 14:03:12 h sshd[1]: x',
      'Oct 25 14:03:12 h sshd[1]: x',
    ],
    ['a string with a newline', '"multi\\nline"', 'multi line', 'multi line'],
    ['a string holding JSON', JSON.stringify(SYSMON), SYSMON, SYSMON],
    ['an object with a message', WRAPPED, 'Process Create: ...', WRAPPED],
    ['an object without a message', SYSMON, 'no message in object', SYSMON],
    [
      'an object whose message is not a string',
      '{"message":42}',
      'no message in object',
      '{"message":42}',
    ],
    [
      'an object with a blank message',
      '{"message":"  "}',
      'no message in object',
      '{"message":"  "}',
    ],
    ['a blank string', '"   "', 'invalid NDJSON line', 'invalid NDJSON line'],
    ['a number', '42', 'invalid NDJSON line', 'invalid NDJSON line'],
    ['an array', '[{"message":"x"}]', 'invalid NDJSON line', 'invalid NDJSON line'],
    ['null', 'null', 'invalid NDJSON line', 'invalid NDJSON line'],
    ['a boolean', 'true', 'invalid NDJSON line', 'invalid NDJSON line'],
    ['text that is not JSON', 'not json', 'invalid NDJSON line', 'invalid NDJSON line'],
    ['a truncated object', '{"message":"x"', 'invalid NDJSON line', 'invalid NDJSON line'],
  ])('%s: for a line source and an object source', (_name, value, forLine, forObject) => {
    const reasons = new Set(['invalid NDJSON line', 'no message in object']);
    for (const [input, expected] of [
      ['line', forLine],
      ['object', forObject],
    ] as const) {
      const decoded = decodeBody(`${value}\n`, 'ndjson', input);
      if (reasons.has(expected)) {
        expect(decoded, input).toEqual({
          lines: [''],
          rejections: [{ line: 1, reason: expected }],
        });
      } else {
        expect(decoded, input).toEqual({ lines: [expected], rejections: [] });
      }
    }
  });

  it('rejects invalid NDJSON lines but keeps line numbers', () => {
    const decoded = decodeBody('"ok"\nnot json\n42\n[1]\nnull\n"   "\n"ok"', 'ndjson', 'line');
    expect(decoded.lines).toEqual(['ok', '', '', '', '', '', 'ok']);
    expect(decoded.rejections.map((r) => r.line)).toEqual([2, 3, 4, 5, 6]);
    expect(decoded.rejections.every((r) => r.reason === 'invalid NDJSON line')).toBe(true);
  });

  it('keeps blank lines blank, without a rejection', () => {
    expect(decodeBody('"a"\n\n  \n"b"', 'ndjson', 'line')).toEqual({
      lines: ['a', '', '', 'b'],
      rejections: [],
    });
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
    pending: 0,
    late: 0,
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
