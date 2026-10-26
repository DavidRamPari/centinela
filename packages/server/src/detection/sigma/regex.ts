/**
 * `|re` patterns run against attacker-controlled log content, so they compile with RE2
 * (`re2-wasm`), whose matching time is linear in the input (ARCHITECTURE §5.6, D-007).
 * Patterns RE2 cannot express (backreferences, lookaround) make the rule unsupported.
 */
import { RE2 } from 're2-wasm';
import { UnsupportedRuleError } from '../errors.js';

export interface RegexFlags {
  /** `|re|i`: ignore case. */
  ignoreCase: boolean;
  /** `|re|m`: `^` and `$` match at line breaks. */
  multiline: boolean;
  /** `|re|s`: `.` matches line breaks. */
  dotAll: boolean;
}

export interface CompiledRegex {
  test(value: string): boolean;
}

export function compileRegex(pattern: string, flags: RegexFlags): CompiledRegex {
  // re2-wasm only runs in Unicode mode, so `u` is always set.
  const flagText = `u${flags.ignoreCase ? 'i' : ''}${flags.multiline ? 'm' : ''}${flags.dotAll ? 's' : ''}`;
  let re: RE2;
  try {
    re = new RE2(pattern, flagText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid pattern';
    throw new UnsupportedRuleError('regex:not-re2', detail);
  }
  return { test: (value) => re.test(value) };
}
