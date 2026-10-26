/**
 * Turning an ingest request body into lines for the pipeline.
 *
 * - `text/plain`: one log line per line (`\n` or `\r\n`).
 * - `application/x-ndjson`: one JSON value per line. A JSON string is the log line; an
 *   object with a string `message` contributes that message; any other object is passed
 *   on as its JSON text (object-shaped sources such as Sysmon parse it themselves).
 *   Lines that are not JSON, or JSON of another type, are rejected here.
 */
import type { IngestSummary } from '../pipeline/types.js';

export type BodyFormat = 'text' | 'ndjson';

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

function decodeNdjsonLine(text: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const message: unknown = (value as Record<string, unknown>).message;
    return typeof message === 'string' ? message : text;
  }
  return undefined;
}

export function decodeBody(body: string, format: BodyFormat): DecodedBody {
  const raw = splitLines(body);
  if (format === 'text') return { lines: raw, rejections: [] };
  const rejections: DecodedBody['rejections'] = [];
  const lines = raw.map((text, index) => {
    if (text.trim() === '') return '';
    const decoded = decodeNdjsonLine(text);
    if (decoded === undefined || decoded.trim() === '') {
      rejections.push({ line: index + 1, reason: 'invalid NDJSON line' });
      return '';
    }
    // A JSON string may hold a newline; the line is one event, so keep it on one line.
    return decoded.replace(/[\r\n]+/g, ' ');
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
