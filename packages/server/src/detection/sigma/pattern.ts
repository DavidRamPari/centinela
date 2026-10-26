/**
 * Sigma string values (ARCHITECTURE §5.3): literal text plus the wildcards `*` (any
 * sequence, including empty) and `?` (exactly one character), and the dash class that
 * `|windash` introduces. Patterns compile to plain string operations (`===`,
 * `startsWith`, `endsWith`, `includes`) when they can, and otherwise to a segment matcher
 * whose cost is linear in the value for each segment. No regular expression is built from
 * a rule value, so wildcards cannot cause catastrophic backtracking.
 */

export type PatternToken =
  | { kind: 'text'; text: string }
  /** `*` */
  | { kind: 'any' }
  /** `?` */
  | { kind: 'one' }
  /** one of `WINDASH_CHARS` (added by `|windash`) */
  | { kind: 'dash' };

/** `-`, `/`, en dash, em dash and horizontal bar (pySigma's windash variants). */
export const WINDASH_CHARS: readonly string[] = ['-', '/', '–', '—', '―'];
const WINDASH_CODES = new Set(WINDASH_CHARS.map((c) => c.charCodeAt(0)));

/** Merge adjacent text tokens and collapse runs of `*`. */
export function normalizeTokens(tokens: readonly PatternToken[]): PatternToken[] {
  const out: PatternToken[] = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (token.kind === 'text') {
      if (token.text === '') continue;
      if (last?.kind === 'text')
        out[out.length - 1] = { kind: 'text', text: last.text + token.text };
      else out.push(token);
    } else if (token.kind === 'any' && last?.kind === 'any') {
      continue;
    } else {
      out.push(token);
    }
  }
  return out;
}

/**
 * Parse a rule string with pySigma's `SigmaString` rules: `*` and `?` are wildcards;
 * `\*`, `\?` and `\\` are a literal `*`, `?` and `\`; a backslash before any other
 * character (or at the end) is a literal backslash, so Windows paths need no escaping.
 */
export function parseSigmaString(raw: string): PatternToken[] {
  const tokens: PatternToken[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') tokens.push({ kind: 'text', text });
    text = '';
  };
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i] ?? '';
    if (c === '\\') {
      const next = raw[i + 1];
      if (next === '*' || next === '?' || next === '\\') {
        text += next;
        i += 1;
      } else {
        text += '\\';
      }
    } else if (c === '*') {
      flush();
      tokens.push({ kind: 'any' });
    } else if (c === '?') {
      flush();
      tokens.push({ kind: 'one' });
    } else {
      text += c;
    }
  }
  flush();
  return normalizeTokens(tokens);
}

/** A pattern made only of literal text (no wildcard or dash class). */
export function isPlain(tokens: readonly PatternToken[]): boolean {
  return tokens.every((t) => t.kind === 'text');
}

/** The literal text of a plain pattern. */
export function plainText(tokens: readonly PatternToken[]): string {
  return tokens.map((t) => (t.kind === 'text' ? t.text : '')).join('');
}

/** `|contains`: `*v*` (no extra wildcard where one already is). */
export function wrapContains(tokens: readonly PatternToken[]): PatternToken[] {
  return wrapEnd(wrapStart(tokens));
}

/** `|endswith`: `*v`. */
export function wrapStart(tokens: readonly PatternToken[]): PatternToken[] {
  return tokens[0]?.kind === 'any' ? [...tokens] : [{ kind: 'any' }, ...tokens];
}

/** `|startswith`: `v*`. */
export function wrapEnd(tokens: readonly PatternToken[]): PatternToken[] {
  return tokens[tokens.length - 1]?.kind === 'any' ? [...tokens] : [...tokens, { kind: 'any' }];
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && WORD_CHAR.test(c);
}

/**
 * `|windash` (pySigma `\B[-/]\b`, applied to each text part): a `-` or `/` preceded by the
 * start of the part or a non-word character and followed by a word character becomes the
 * dash class, so `-s` also matches `/s`, `–s`, `—s` and `―s`. Each position varies
 * independently, which is what pySigma's expansion into every combination means.
 */
export function applyWindash(tokens: readonly PatternToken[]): PatternToken[] {
  const out: PatternToken[] = [];
  for (const token of tokens) {
    if (token.kind !== 'text') {
      out.push(token);
      continue;
    }
    const { text } = token;
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if ((c === '-' || c === '/') && !isWordChar(text[i - 1]) && isWordChar(text[i + 1])) {
        out.push({ kind: 'text', text: text.slice(start, i) });
        out.push({ kind: 'dash' });
        start = i + 1;
      }
    }
    out.push({ kind: 'text', text: text.slice(start) });
  }
  return normalizeTokens(out);
}

/** Lower-case every text token (case-insensitive matching lower-cases the value too). */
export function lowerTokens(tokens: readonly PatternToken[]): PatternToken[] {
  return tokens.map((t) => (t.kind === 'text' ? { kind: 'text', text: t.text.toLowerCase() } : t));
}

/** One fixed-length piece of a pattern between two `*`. */
interface Segment {
  /** Set when the segment is pure literal text. */
  literal: string | null;
  /** Per position: a character code, `-1` for `?` or `-2` for the dash class. */
  units: number[];
  /** Longest literal run of the segment and its offset, used to search with `indexOf`. */
  anchor: string;
  anchorOffset: number;
}

const UNIT_ONE = -1;
const UNIT_DASH = -2;

function longestLiteralRun(units: readonly number[]): { anchor: string; anchorOffset: number } {
  let best = { anchor: '', anchorOffset: 0 };
  let start = 0;
  for (let i = 0; i <= units.length; i += 1) {
    const unit = units[i];
    if (unit === undefined || unit < 0) {
      if (i - start > best.anchor.length) {
        let anchor = '';
        for (let k = start; k < i; k += 1) anchor += String.fromCharCode(units[k] ?? 0);
        best = { anchor, anchorOffset: start };
      }
      start = i + 1;
    }
  }
  return best;
}

function toSegments(tokens: readonly PatternToken[]): Segment[] {
  const segments: Segment[] = [];
  let units: number[] = [];
  let text = '';
  let literal = true;
  const close = () => {
    if (units.length > 0) {
      segments.push({ literal: literal ? text : null, units, ...longestLiteralRun(units) });
    }
    units = [];
    text = '';
    literal = true;
  };
  for (const token of tokens) {
    if (token.kind === 'any') close();
    else if (token.kind === 'one') {
      units.push(UNIT_ONE);
      literal = false;
    } else if (token.kind === 'dash') {
      units.push(UNIT_DASH);
      literal = false;
    } else {
      text += token.text;
      for (let i = 0; i < token.text.length; i += 1) units.push(token.text.charCodeAt(i));
    }
  }
  close();
  return segments;
}

function matchAt(value: string, segment: Segment, at: number): boolean {
  if (segment.literal !== null) return value.startsWith(segment.literal, at);
  const { units } = segment;
  for (let k = 0; k < units.length; k += 1) {
    const unit = units[k] ?? 0;
    const code = value.charCodeAt(at + k);
    if (unit === UNIT_ONE) continue;
    if (unit === UNIT_DASH) {
      if (!WINDASH_CODES.has(code)) return false;
    } else if (unit !== code) {
      return false;
    }
  }
  return true;
}

/** Leftmost position >= `from` where `segment` matches and ends at or before `limit`. */
function find(value: string, segment: Segment, from: number, limit: number): number {
  const length = segment.units.length;
  if (segment.literal !== null) {
    const index = value.indexOf(segment.literal, from);
    return index !== -1 && index + length <= limit ? index : -1;
  }
  const { anchor, anchorOffset } = segment;
  if (anchor === '') {
    for (let at = from; at + length <= limit; at += 1) {
      if (matchAt(value, segment, at)) return at;
    }
    return -1;
  }
  // Candidates are the occurrences of the anchor, in increasing order.
  let search = from + anchorOffset;
  for (;;) {
    const index = value.indexOf(anchor, search);
    if (index === -1) return -1;
    const at = index - anchorOffset;
    if (at + length > limit) return -1;
    if (matchAt(value, segment, at)) return at;
    search = index + 1;
  }
}

export type StringMatcher = (value: string) => boolean;

/**
 * Compile a pattern into a predicate over the (already case-folded, if needed) value.
 * Segments are fixed-length, so taking the leftmost match of each middle segment is
 * optimal; the first and last segments are anchored unless the pattern starts or ends
 * with `*`.
 */
export function compilePattern(tokens: readonly PatternToken[]): StringMatcher {
  const normalized = normalizeTokens(tokens);
  if (normalized.length === 0) return (value) => value === '';
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  const anchoredStart = first?.kind !== 'any';
  const anchoredEnd = last?.kind !== 'any';
  const segments = toSegments(normalized);

  // Fast paths for the shapes almost every rule uses.
  const only = segments.length === 1 ? segments[0] : undefined;
  if (segments.length === 0) return () => true;
  if (only !== undefined && only.literal !== null) {
    const text = only.literal;
    if (anchoredStart && anchoredEnd) return (value) => value === text;
    if (anchoredStart) return (value) => value.startsWith(text);
    if (anchoredEnd) return (value) => value.endsWith(text);
    return (value) => value.includes(text);
  }

  return (value) => {
    let pos = 0;
    let firstIndex = 0;
    let lastIndex = segments.length - 1;
    let limit = value.length;
    if (anchoredStart && anchoredEnd && segments.length === 1 && only) {
      return value.length === only.units.length && matchAt(value, only, 0);
    }
    if (anchoredStart) {
      const head = segments[0];
      if (!head || head.units.length > value.length || !matchAt(value, head, 0)) return false;
      pos = head.units.length;
      firstIndex = 1;
    }
    if (anchoredEnd) {
      const tail = segments[lastIndex];
      if (!tail) return false;
      const at = value.length - tail.units.length;
      if (at < pos || !matchAt(value, tail, at)) return false;
      limit = at;
      lastIndex -= 1;
    }
    for (let i = firstIndex; i <= lastIndex; i += 1) {
      const segment = segments[i];
      if (!segment) return false;
      const index = find(value, segment, pos, limit);
      if (index === -1) return false;
      pos = index + segment.units.length;
    }
    return true;
  };
}
