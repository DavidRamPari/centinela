/**
 * Split text holding JSON values back to back (pretty-printed objects one after another,
 * as in some SigmaHQ regression files) into the parsed values. Only objects and arrays are
 * expected at the top level; anything else is an error.
 */
export function parseConcatenatedJson(text: string): unknown[] {
  const values: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c !== '{' && c !== '[') throw new SyntaxError(`unexpected character at offset ${i}`);
    const start = i;
    let depth = 0;
    let inString = false;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{' || ch === '[') {
        depth += 1;
      } else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    if (depth !== 0) throw new SyntaxError('unterminated JSON value');
    values.push(JSON.parse(text.slice(start, i)) as unknown);
  }
  return values;
}
