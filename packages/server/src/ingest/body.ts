/**
 * Turning an ingest request body into lines for the pipeline (ARCHITECTURE §9).
 *
 * - `text/plain`: one log line per line (`\n` or `\r\n`).
 * - `application/x-ndjson`: one JSON value per line, read by what the source's parser takes
 *   (`Parser.input`, S11):
 *
 *   | JSON value         | `line` source                          | `object` source           |
 *   | ------------------ | -------------------------------------- | ------------------------- |
 *   | a string           | the string                             | the string                |
 *   | an object          | its string `message`, else rejected    | the object's JSON text    |
 *   | anything else      | rejected                               | rejected                  |
 *
 *   An event a shipper wraps with a `message` key (Winlogbeat does) therefore still
 *   reaches an object parser whole (this closes S5-09).
 */
import type { ParserInput, IngestSummary } from '../pipeline/types.js';

export type BodyFormat = 'text' | 'ndjson';

export const INVALID_NDJSON_REASON = 'invalid NDJSON line';
export const NO_MESSAGE_REASON = 'no message in object';

export interface DecodedBody {
  /** One entry per input line; rejected NDJSON lines are blank so line numbers stay put. */
  lines: string[];
  rejections: Array<{ line: number; reason: string }>;
}

export function splitLines(body: string): string[] {
  if (body === '') return [];
  const lines = body.split('\n');
  // A trailing newline does not start another line.
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type Decoded = { ok: true; text: string } | { ok: false; reason: string };

function decodeNdjsonLine(text: string, input: ParserInput): Decoded {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: INVALID_NDJSON_REASON };
  }
  if (typeof value === 'string') {
    return value.trim() === ''
      ? { ok: false, reason: INVALID_NDJSON_REASON }
      : // A JSON string may hold a newline; the line is one event, so keep it on one line.
        { ok: true, text: value.replace(/[\r\n]+/g, ' ') };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: INVALID_NDJSON_REASON };
  }
  // The object's own JSON text: NDJSON lines hold no raw newline, and the parser reads it.
  if (input === 'object') return { ok: true, text: text.trim() };
  const message: unknown = (value as Record<string, unknown>).message;
  if (typeof message !== 'string' || message.trim() === '') {
    return { ok: false, reason: NO_MESSAGE_REASON };
  }
  return { ok: true, text: message.replace(/[\r\n]+/g, ' ') };
}

export function decodeBody(body: string, format: BodyFormat, input: ParserInput): DecodedBody {
  const raw = splitLines(body);
  if (format === 'text') return { lines: raw, rejections: [] };
  const rejections: DecodedBody['rejections'] = [];
  const lines = raw.map((text, index) => {
    if (text.trim() === '') return '';
    const decoded = decodeNdjsonLine(text, input);
    if (!decoded.ok) {
      rejections.push({ line: index + 1, reason: decoded.reason });
      return '';
    }
    return decoded.text;
  });
  return { lines, rejections };
}

/** Add rejections found before the pipeline to its summary (samples stay in line order). */
export function mergeRejections(
  summary: IngestSummary,
  extra: DecodedBody['rejections'],
  maxSamples: number,
): IngestSummary {
  if (extra.length === 0) return summary;
  const rejections = [...summary.rejections, ...extra]
    .sort((a, b) => a.line - b.line)
    .slice(0, maxSamples);
  return { ...summary, rejected: summary.rejected + extra.length, rejections };
}
