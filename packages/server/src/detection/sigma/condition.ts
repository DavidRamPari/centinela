/**
 * Sigma condition grammar (ARCHITECTURE §5.4), parsed by recursive descent:
 *
 *   condition  := or_expr
 *   or_expr    := and_expr ( "or" and_expr )*
 *   and_expr   := not_expr ( "and" not_expr )*
 *   not_expr   := "not" not_expr | primary
 *   primary    := "(" or_expr ")" | quantifier | identifier
 *   quantifier := ( "1" | "any" | "all" ) "of" ( pattern | "them" )
 *
 * Keywords are case-insensitive; identifiers are not. Quantifiers are resolved against the
 * rule's search identifiers when the condition is parsed, so evaluation is a plain tree.
 */
import { UnsupportedRuleError } from '../errors.js';

export type ConditionNode =
  | { op: 'and'; args: ConditionNode[] }
  | { op: 'or'; args: ConditionNode[] }
  | { op: 'not'; arg: ConditionNode }
  | { op: 'ref'; name: string };

type Token =
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  /** An identifier, pattern or keyword; `lower` is used to recognize keywords. */
  | { kind: 'word'; text: string; lower: string };

const WORD_CHAR = /[A-Za-z0-9_*]/;

export function tokenizeCondition(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
    } else if (c === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
    } else if (c === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
    } else if (c === '|') {
      throw new UnsupportedRuleError('condition:aggregation');
    } else if (WORD_CHAR.test(c)) {
      let end = i;
      while (end < text.length && WORD_CHAR.test(text[end] ?? '')) end += 1;
      const word = text.slice(i, end);
      tokens.push({ kind: 'word', text: word, lower: word.toLowerCase() });
      i = end;
    } else {
      throw new UnsupportedRuleError('condition:syntax', `unexpected character '${c}'`);
    }
  }
  return tokens;
}

const KEYWORDS = new Set(['and', 'or', 'not', 'of', 'them']);
const QUANTIFIERS = new Set(['1', 'any', 'all']);

/** Full-string match of an identifier pattern where `*` is any sequence. */
export function identifierPatternMatches(pattern: string, name: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === name;
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  if (!name.startsWith(first) || name.length < first.length + last.length) return false;
  if (!name.endsWith(last)) return false;
  let pos = first.length;
  const limit = name.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const index = name.indexOf(part, pos);
    if (index === -1 || index + part.length > limit) return false;
    pos = index + part.length;
  }
  return true;
}

/**
 * Parse a condition against the rule's search identifiers (in declaration order).
 * Unknown identifiers, quantifier patterns that match nothing and syntax errors make the
 * rule unsupported.
 */
export function parseCondition(text: string, identifiers: readonly string[]): ConditionNode {
  const tokens = tokenizeCondition(text);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const isWord = (token: Token | undefined, lower: string) =>
    token?.kind === 'word' && token.lower === lower;
  const fail = (detail: string): never => {
    throw new UnsupportedRuleError('condition:syntax', detail);
  };

  function parseOr(): ConditionNode {
    const args = [parseAnd()];
    while (isWord(peek(), 'or')) {
      pos += 1;
      args.push(parseAnd());
    }
    return args.length === 1 && args[0] ? args[0] : { op: 'or', args };
  }

  function parseAnd(): ConditionNode {
    const args = [parseNot()];
    while (isWord(peek(), 'and')) {
      pos += 1;
      args.push(parseNot());
    }
    return args.length === 1 && args[0] ? args[0] : { op: 'and', args };
  }

  function parseNot(): ConditionNode {
    if (isWord(peek(), 'not')) {
      pos += 1;
      return { op: 'not', arg: parseNot() };
    }
    return parsePrimary();
  }

  function parseQuantifier(quantifier: string): ConditionNode {
    pos += 2; // quantifier and "of"
    const target = peek();
    if (target?.kind !== 'word' || (KEYWORDS.has(target.lower) && target.lower !== 'them')) {
      return fail(`expected a pattern or "them" after "${quantifier} of"`);
    }
    pos += 1;
    const names =
      target.lower === 'them'
        ? identifiers.filter((name) => !name.startsWith('_'))
        : identifiers.filter((name) => identifierPatternMatches(target.text, name));
    if (names.length === 0) {
      throw new UnsupportedRuleError('condition:empty-quantifier', target.text);
    }
    const refs: ConditionNode[] = names.map((name) => ({ op: 'ref', name }));
    if (refs.length === 1 && refs[0]) return refs[0];
    return { op: quantifier === 'all' ? 'and' : 'or', args: refs };
  }

  function parsePrimary(): ConditionNode {
    const token = peek();
    if (token === undefined) return fail('unexpected end of condition');
    if (token.kind === 'lparen') {
      pos += 1;
      const inner = parseOr();
      if (peek()?.kind !== 'rparen') return fail('missing ")"');
      pos += 1;
      return inner;
    }
    if (token.kind === 'rparen') return fail('unexpected ")"');
    if (QUANTIFIERS.has(token.lower) && isWord(tokens[pos + 1], 'of')) {
      return parseQuantifier(token.lower);
    }
    if (token.lower === 'near') throw new UnsupportedRuleError('condition:near');
    if (KEYWORDS.has(token.lower)) return fail(`unexpected "${token.text}"`);
    if (token.text.includes('*')) return fail(`pattern "${token.text}" outside a quantifier`);
    if (!identifiers.includes(token.text)) {
      throw new UnsupportedRuleError('condition:unknown-identifier', token.text);
    }
    pos += 1;
    return { op: 'ref', name: token.text };
  }

  const tree = parseOr();
  const rest = peek();
  if (rest !== undefined) {
    if (rest.kind === 'word' && rest.lower === 'near') {
      throw new UnsupportedRuleError('condition:near');
    }
    fail(rest.kind === 'word' ? `unexpected "${rest.text}"` : 'unexpected parenthesis');
  }
  return tree;
}

/** Compile a parsed condition into a predicate over the selection results. */
export function compileCondition<T>(
  node: ConditionNode,
  selection: (name: string) => (input: T) => boolean,
): (input: T) => boolean {
  switch (node.op) {
    case 'ref':
      return selection(node.name);
    case 'not': {
      const inner = compileCondition(node.arg, selection);
      return (input) => !inner(input);
    }
    case 'and': {
      const args = node.args.map((arg) => compileCondition(arg, selection));
      return (input) => {
        for (let i = 0; i < args.length; i += 1) if (!args[i]?.(input)) return false;
        return true;
      };
    }
    case 'or': {
      const args = node.args.map((arg) => compileCondition(arg, selection));
      return (input) => {
        for (let i = 0; i < args.length; i += 1) if (args[i]?.(input)) return true;
        return false;
      };
    }
  }
}
