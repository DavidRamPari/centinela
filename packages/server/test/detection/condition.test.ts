import { describe, expect, it } from 'vitest';
import { UnsupportedRuleError } from '../../src/detection/errors.js';
import {
  identifierPatternMatches,
  parseCondition,
  tokenizeCondition,
} from '../../src/detection/sigma/condition.js';
import { compileDetection } from '../../src/detection/sigma/compile.js';
import { matches } from './helpers.js';

/** Selections `a`, `b`, `c`, ... that match when the event's `on` field contains their name. */
function flags(condition: string | string[], names = ['a', 'b', 'c']) {
  const detection: Record<string, unknown> = { condition };
  for (const name of names) detection[name] = { 'on|contains': `[${name}]` };
  return (...on: string[]) =>
    matches(detection, { fields: { on: on.map((n) => `[${n}]`).join('') } });
}

function reasonOf(condition: string, names = ['a', 'b']): string {
  try {
    parseCondition(condition, names);
  } catch (error) {
    if (error instanceof UnsupportedRuleError) return error.code;
    throw error;
  }
  return 'supported';
}

describe('condition grammar', () => {
  it('a single identifier', () => {
    const rule = flags('a');
    expect(rule('a')).toBe(true);
    expect(rule('b')).toBe(false);
  });

  it('and, or and not', () => {
    expect(flags('a and b')('a')).toBe(false);
    expect(flags('a and b')('a', 'b')).toBe(true);
    expect(flags('a or b')('b')).toBe(true);
    expect(flags('a and not b')('a', 'b')).toBe(false);
    expect(flags('a and not b')('a')).toBe(true);
  });

  it('not binds tighter than and, and tighter than or', () => {
    // a or b and c  ==  a or (b and c)
    const rule = flags('a or b and c');
    expect(rule('a')).toBe(true);
    expect(rule('b')).toBe(false);
    expect(rule('b', 'c')).toBe(true);
    // not a and b  ==  (not a) and b
    const negated = flags('not a and b');
    expect(negated('b')).toBe(true);
    expect(negated('a', 'b')).toBe(false);
    expect(negated()).toBe(false);
  });

  it('parentheses override precedence', () => {
    const rule = flags('(a or b) and c');
    expect(rule('a')).toBe(false);
    expect(rule('a', 'c')).toBe(true);
    expect(flags('not (a or b)')()).toBe(true);
    expect(flags('not (a or b)')('b')).toBe(false);
  });

  it('double negation and nested parentheses', () => {
    expect(flags('not not a')('a')).toBe(true);
    expect(flags('((a))')('a')).toBe(true);
  });

  it('keywords are case-insensitive', () => {
    expect(flags('a AND NOT b')('a')).toBe(true);
    expect(flags('1 OF Them', ['x', 'y'])('y')).toBe(true);
  });

  it('1 of / any of with a wildcard pattern', () => {
    const names = ['selection_img', 'selection_cli', 'filter'];
    expect(flags('1 of selection_*', names)('selection_cli')).toBe(true);
    expect(flags('any of selection_*', names)('selection_img')).toBe(true);
    expect(flags('1 of selection_*', names)('filter')).toBe(false);
  });

  it('all of with a wildcard pattern', () => {
    const names = ['selection_img', 'selection_cli', 'filter'];
    const rule = flags('all of selection_*', names);
    expect(rule('selection_img')).toBe(false);
    expect(rule('selection_img', 'selection_cli')).toBe(true);
  });

  it('them is every identifier except those starting with _', () => {
    const names = ['a', 'b', '_helper'];
    expect(flags('all of them', names)('a', 'b')).toBe(true);
    expect(flags('1 of them', names)('_helper')).toBe(false);
    expect(flags('1 of _*', names)('_helper')).toBe(true);
  });

  it('a pattern in the middle of an identifier', () => {
    const names = ['sel_proc_a', 'sel_net_a', 'sel_proc_b'];
    expect(flags('all of sel_*_a', names)('sel_proc_a', 'sel_net_a')).toBe(true);
    expect(flags('all of sel_*_a', names)('sel_proc_a')).toBe(false);
  });

  it('quantifiers combine with other operators', () => {
    const names = ['selection_img', 'selection_cli', 'filter_main_a', 'filter_optional_b'];
    const condition =
      'all of selection_* and not 1 of filter_main_* and not 1 of filter_optional_*';
    const rule = flags(condition, names);
    expect(rule('selection_img', 'selection_cli')).toBe(true);
    expect(rule('selection_img', 'selection_cli', 'filter_optional_b')).toBe(false);
  });

  it('a list of conditions is their OR', () => {
    const rule = flags(['a and b', 'c']);
    expect(rule('c')).toBe(true);
    expect(rule('a')).toBe(false);
    expect(rule('a', 'b')).toBe(true);
  });

  it('multi-line conditions', () => {
    expect(flags('a\n  and not\n  b\n')('a')).toBe(true);
  });

  it('identifier patterns match whole names', () => {
    expect(identifierPatternMatches('sel*', 'selection')).toBe(true);
    expect(identifierPatternMatches('sel*', 'xselection')).toBe(false);
    expect(identifierPatternMatches('*_a', 'sel_a')).toBe(true);
    expect(identifierPatternMatches('a*a', 'a')).toBe(false);
    expect(identifierPatternMatches('exact', 'exact')).toBe(true);
  });

  it('tokenizes words and parentheses', () => {
    expect(
      tokenizeCondition('(a or b*)').map((t) => (t.kind === 'word' ? t.text : t.kind)),
    ).toEqual(['lparen', 'a', 'or', 'b*', 'rparen']);
  });
});

describe('unsupported conditions', () => {
  it('aggregations', () => {
    expect(reasonOf('a | count() by host > 10')).toBe('condition:aggregation');
  });

  it('near', () => {
    expect(reasonOf('a near b')).toBe('condition:near');
  });

  it('unknown identifiers', () => {
    expect(reasonOf('a and missing')).toBe('condition:unknown-identifier');
  });

  it('a quantifier pattern that matches nothing', () => {
    expect(reasonOf('1 of filter_*')).toBe('condition:empty-quantifier');
    expect(reasonOf('all of them', ['_only'])).toBe('condition:empty-quantifier');
  });

  it('syntax errors', () => {
    for (const condition of [
      'a and',
      '(a or b',
      'a b',
      'a)',
      'and a',
      'a or or b',
      'sel*',
      'a = b',
      '1 of',
    ]) {
      expect(reasonOf(condition), condition).toBe('condition:syntax');
    }
  });

  it('a missing or empty condition', () => {
    expect(() => compileDetection({ a: { x: 1 } })).toThrow(UnsupportedRuleError);
    expect(() => compileDetection({ a: { x: 1 }, condition: '  ' })).toThrow(UnsupportedRuleError);
    expect(() => compileDetection({ a: { x: 1 }, condition: [] })).toThrow(UnsupportedRuleError);
  });

  it('timeframe in a single-event rule', () => {
    expect(() => compileDetection({ a: { x: 1 }, timeframe: '5m', condition: 'a' })).toThrow(
      'detection:timeframe',
    );
  });
});

describe('selections', () => {
  it('a map ANDs its fields', () => {
    const detection = {
      selection: { Image: '*\\cmd.exe', CommandLine: '*/c*' },
      condition: 'selection',
    };
    expect(
      matches(detection, { fields: { Image: 'C:\\cmd.exe', CommandLine: 'cmd /c dir' } }),
    ).toBe(true);
    expect(matches(detection, { fields: { Image: 'C:\\cmd.exe', CommandLine: 'cmd' } })).toBe(
      false,
    );
  });

  it('a list of maps ORs the maps', () => {
    const detection = {
      selection: [{ Image: '*\\certutil.exe' }, { OriginalFileName: 'CertUtil.exe' }],
      condition: 'selection',
    };
    expect(matches(detection, { fields: { OriginalFileName: 'certutil.exe' } })).toBe(true);
    expect(matches(detection, { fields: { Image: 'C:\\x.exe' } })).toBe(false);
  });

  it('a list mixing keywords and maps ORs every entry', () => {
    const detection = { selection: ['needle', { Image: '*\\x.exe' }], condition: 'selection' };
    expect(matches(detection, { message: 'a needle here' })).toBe(true);
    expect(matches(detection, { fields: { Image: 'C:\\x.exe' } })).toBe(true);
    expect(matches(detection, { message: 'nothing' })).toBe(false);
  });

  it('identical selections in different rules share one compiled predicate', () => {
    const a = { selection: { Image: '*\\cmd.exe' }, condition: 'selection' };
    const b = {
      selection: { Image: '*\\cmd.exe' },
      filter: { User: 'x' },
      condition: 'selection and not filter',
    };
    expect(matches(a, { fields: { Image: 'C:\\cmd.exe' } })).toBe(true);
    expect(matches(b, { fields: { Image: 'C:\\cmd.exe', User: 'x' } })).toBe(false);
  });

  it('reject empty selections and nested lists', () => {
    expect(() => compileDetection({ s: {}, condition: 's' })).toThrow('detection:empty-selection');
    expect(() => compileDetection({ s: [], condition: 's' })).toThrow('detection:empty-selection');
    expect(() => compileDetection({ s: [['a']], condition: 's' })).toThrow(
      'detection:invalid-selection',
    );
    expect(() => compileDetection({ s: { f: [] }, condition: 's' })).toThrow(
      'detection:empty-value',
    );
    expect(() => compileDetection({ s: { f: { nested: 1 } }, condition: 's' })).toThrow(
      'detection:invalid-value',
    );
  });
});
