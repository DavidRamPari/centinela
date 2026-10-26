/**
 * Stream lines out of a byte stream without ever holding more than one (capped) line in
 * memory. A line longer than `maxLength` keeps its first `maxLength` characters; the
 * rest, up to the next newline, is skipped. The parsers cut lines further anyway, so
 * a file with a gigabyte-long line cannot exhaust memory.
 */
import { StringDecoder } from 'node:string_decoder';
import { MAX_LINE_LENGTH } from '../parsers/index.js';

export async function* readLines(
  chunks: AsyncIterable<Buffer | string>,
  maxLength: number = MAX_LINE_LENGTH,
): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let current = '';
  let truncated = false;

  const append = (text: string) => {
    if (truncated) return;
    const room = maxLength - current.length;
    if (text.length > room) {
      current += text.slice(0, room);
      truncated = true;
    } else {
      current += text;
    }
  };

  for await (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline === -1) break;
      append(text.slice(start, newline));
      yield current;
      current = '';
      truncated = false;
      start = newline + 1;
    }
    append(text.slice(start));
  }
  append(decoder.end());
  if (current !== '') yield current;
}
