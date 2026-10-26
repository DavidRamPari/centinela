import { describe, expect, it } from 'vitest';
import {
  applyWindash,
  compilePattern,
  lowerTokens,
  parseSigmaString,
  wrapContains,
  type PatternToken,
} from '../../src/detection/sigma/pattern.js';

const text = (t: string): PatternToken => ({ kind: 'text', text: t });
const any: PatternToken = { kind: 'any' };
const one: PatternToken = { kind: 'one' };
const dash: PatternToken = { kind: 'dash' };

const glob = (pattern: string) => compilePattern(parseSigmaString(pattern));

describe('parseSigmaString (pySigma escaping)', () => {
  it('reads * and ? as wildcards', () => {
    expect(parseSigmaString('a*b?c')).toEqual([text('a'), any, text('b'), one, text('c')]);
  });

  it('reads \\*, \\? and \\\\ as literal characters', () => {
    expect(parseSigmaString('a\\*b\\?c\\\\d')).toEqual([text('a*b?c\\d')]);
  });

  it('keeps a backslash before any other character, and a trailing one', () => {
    expect(parseSigmaString('C:\\Windows\\System32\\')).toEqual([text('C:\\Windows\\System32\\')]);
  });

  it('collapses runs of * into one', () => {
    expect(parseSigmaString('**a***')).toEqual([any, text('a'), any]);
  });
});

describe('compilePattern', () => {
  it('compares without wildcards for equality', () => {
    expect(glob('cmd.exe')('cmd.exe')).toBe(true);
    expect(glob('cmd.exe')('xcmd.exe')).toBe(false);
  });

  it('turns v*, *v and *v* into prefix, suffix and substring tests', () => {
    expect(glob('pow*')('powershell')).toBe(true);
    expect(glob('*.exe')('cmd.exe')).toBe(true);
    expect(glob('*shell*')('powershell.exe')).toBe(true);
    expect(glob('*shell*')('cmd.exe')).toBe(false);
  });

  it('lets * match the empty string and ? exactly one character', () => {
    expect(glob('a*b')('ab')).toBe(true);
    expect(glob('a?b')('ab')).toBe(false);
    expect(glob('a?b')('axb')).toBe(true);
    expect(glob('a?b')('axxb')).toBe(false);
  });

  it('keeps segment order and does not let anchored segments overlap', () => {
    expect(glob('a*b*c')('a-b-c')).toBe(true);
    expect(glob('a*b*c')('a-c-b')).toBe(false);
    expect(glob('ab*ba')('aba')).toBe(false);
    expect(glob('ab*ba')('abba')).toBe(true);
  });

  it('matches * alone against any value and the empty pattern only against ""', () => {
    expect(glob('*')('')).toBe(true);
    expect(glob('*')('anything')).toBe(true);
    expect(compilePattern([])('')).toBe(true);
    expect(compilePattern([])('x')).toBe(false);
  });

  it('agrees with a reference glob on random patterns and values', () => {
    // Test-only reference: a RegExp built from generated patterns over a tiny alphabet.
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const alphabet = 'ab-';
    for (let round = 0; round < 3000; round += 1) {
      const tokens: PatternToken[] = [];
      const length = next() % 6;
      for (let i = 0; i < length; i += 1) {
        const r = next() % 6;
        tokens.push(
          r === 0 ? any : r === 1 ? one : r === 2 ? dash : text(alphabet[next() % 3] ?? 'a'),
        );
      }
      const source = tokens
        .map((t) =>
          t.kind === 'any'
            ? '.*'
            : t.kind === 'one'
              ? '.'
              : t.kind === 'dash'
                ? '[-/]'
                : t.text === '-'
                  ? '\\-'
                  : t.text,
        )
        .join('');
      const reference = new RegExp(`^${source}$`, 's');
      const value = Array.from({ length: next() % 8 }, () => 'ab-/'[next() % 4]).join('');
      expect(compilePattern(tokens)(value), `${source} on ${value}`).toBe(reference.test(value));
    }
  });

  it('stays fast on long values with many segments', () => {
    const value = 'a'.repeat(8192);
    const started = performance.now();
    expect(glob('*a?a*a?a*a?a*b*')(value)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('windash (pySigma \\B[-/]\\b)', () => {
  it('marks dashes and slashes that start an option', () => {
    expect(applyWindash([text(' -s -i cmd')])).toEqual([
      text(' '),
      dash,
      text('s '),
      dash,
      text('i cmd'),
    ]);
  });

  it('leaves dashes inside words and before non-word characters alone', () => {
    expect(applyWindash([text('x-s')])).toEqual([text('x-s')]);
    expect(applyWindash([text('a - b')])).toEqual([text('a - b')]);
    expect(applyWindash([text('end-')])).toEqual([text('end-')]);
  });

  it('marks only the second dash of a double dash', () => {
    expect(applyWindash([text('--user')])).toEqual([text('-'), dash, text('user')]);
  });

  it('treats the start of a text part after a wildcard as an option start', () => {
    expect(applyWindash([any, text('/c'), any])).toEqual([any, dash, text('c'), any]);
  });

  it('matches every dash variant at each position independently', () => {
    const matcher = compilePattern(
      lowerTokens(wrapContains(applyWindash(parseSigmaString(' -s -i')))),
    );
    for (const variant of [' -s -i', ' /s -i', ' -s /i', ' \u2013s \u2014i', ' \u2015s /i']) {
      expect(matcher(`psexec${variant} cmd`), variant).toBe(true);
    }
    expect(matcher('psexec +s -i cmd')).toBe(false);
  });
});
