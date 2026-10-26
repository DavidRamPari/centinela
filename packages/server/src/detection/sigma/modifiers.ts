/**
 * Detection items: one `field|modifier|...: value(s)` entry of a selection, or a keyword
 * list (field `null`, matched against `message`). Modifiers apply left to right, as in
 * pySigma (ARCHITECTURE §5.3):
 *
 * - string transforms (`contains`, `startswith`, `endswith`, `windash`, the UTF-16
 *   encoders, `base64`, `base64offset`) rewrite the value pattern;
 * - type modifiers (`re`, `cidr`, `exists`, `lt`/`lte`/`gt`/`gte`, `fieldref`) change what
 *   the value means and must come before any transform;
 * - `all` (every value must match) and `cased` (case-sensitive) are flags.
 */
import ipaddr from 'ipaddr.js';
import { UnsupportedRuleError } from '../errors.js';
import { fieldSlot, type EventView } from '../event-view.js';
import {
  encodeBase64,
  encodeBase64Offsets,
  encodeUtf16,
  encodeUtf16be,
  encodeUtf16le,
  type EncodedValue,
} from './encoding.js';
import {
  applyWindash,
  compilePattern,
  isPlain,
  lowerTokens,
  normalizeTokens,
  parseSigmaString,
  plainText,
  wrapContains,
  wrapEnd,
  wrapStart,
  type PatternToken,
  type StringMatcher,
} from './pattern.js';
import type { LiteralIndex, LiteralShape } from './literal-index.js';
import { compileRegex, type CompiledRegex, type RegexFlags } from './regex.js';

export type RuleScalar = string | number | boolean | null;

/**
 * Literal ids (in the rule set's `LiteralIndex`) of which at least one must match for a
 * predicate to be true; null when no such set is known.
 */
export type Requirement = ReadonlySet<number> | null;

export interface DetectionItem {
  /** `null` for keyword items. */
  readonly field: string | null;
  test(view: EventView): boolean;
  readonly requires: Requirement;
}

const STRING_TRANSFORMS = new Set([
  'contains',
  'startswith',
  'endswith',
  'windash',
  'wide',
  'utf16le',
  'utf16be',
  'utf16',
  'base64',
  'base64offset',
]);

const NUMERIC_OPERATORS = new Set(['lt', 'lte', 'gt', 'gte']);
const REGEX_FLAGS: Readonly<Record<string, keyof RegexFlags>> = {
  i: 'ignoreCase',
  ignorecase: 'ignoreCase',
  m: 'multiline',
  multiline: 'multiline',
  s: 'dotAll',
  dotall: 'dotAll',
};

type ValueType = 'string' | 're' | 'cidr' | 'exists' | 'numeric' | 'fieldref';

interface ModifierPlan {
  type: ValueType;
  numericOperator: string | null;
  transforms: string[];
  all: boolean;
  cased: boolean;
  regexFlags: RegexFlags;
}

/** Validate and classify the modifier chain of a detection key. */
export function planModifiers(modifiers: readonly string[]): ModifierPlan {
  const plan: ModifierPlan = {
    type: 'string',
    numericOperator: null,
    transforms: [],
    all: false,
    cased: false,
    regexFlags: { ignoreCase: false, multiline: false, dotAll: false },
  };
  for (const modifier of modifiers) {
    if (modifier === 'expand') throw new UnsupportedRuleError('modifier:expand');
    if (modifier === 'all') {
      plan.all = true;
    } else if (modifier === 'cased') {
      plan.cased = true;
    } else if (STRING_TRANSFORMS.has(modifier)) {
      if (plan.type !== 'string') {
        throw new UnsupportedRuleError('modifier:incompatible', `${plan.type}|${modifier}`);
      }
      plan.transforms.push(modifier);
    } else if (Object.hasOwn(REGEX_FLAGS, modifier) && plan.type === 're') {
      const flag = REGEX_FLAGS[modifier];
      if (flag !== undefined) plan.regexFlags[flag] = true;
    } else if (
      modifier === 're' ||
      modifier === 'cidr' ||
      modifier === 'exists' ||
      modifier === 'fieldref' ||
      NUMERIC_OPERATORS.has(modifier)
    ) {
      if (plan.type !== 'string' || plan.transforms.length > 0) {
        const previous = plan.type === 'string' ? plan.transforms.join('|') : plan.type;
        throw new UnsupportedRuleError('modifier:incompatible', `${previous}|${modifier}`);
      }
      if (NUMERIC_OPERATORS.has(modifier)) {
        plan.type = 'numeric';
        plan.numericOperator = modifier;
      } else {
        plan.type = modifier as ValueType;
      }
    } else {
      throw new UnsupportedRuleError('modifier:unknown', modifier === '' ? '(empty)' : modifier);
    }
  }
  if (plan.cased && plan.type !== 'string') {
    throw new UnsupportedRuleError('modifier:incompatible', `${plan.type}|cased`);
  }
  return plan;
}

/** Normalize a YAML value into a list of scalars. */
export function toValueList(value: unknown): RuleScalar[] {
  const list = Array.isArray(value) ? (value as unknown[]) : [value];
  if (list.length === 0) throw new UnsupportedRuleError('detection:empty-value');
  return list.map((item) => {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      return item;
    }
    throw new UnsupportedRuleError('detection:invalid-value', typeof item);
  });
}

interface PatternVariant {
  tokens: PatternToken[];
  binary: boolean;
  cased: boolean;
}

function encodeOnce(
  transform: string,
  variant: PatternVariant,
  encode: (value: EncodedValue) => EncodedValue,
): PatternVariant {
  if (!isPlain(variant.tokens)) {
    throw new UnsupportedRuleError('modifier:wildcard-encoding', transform);
  }
  const encoded = encode({ text: plainText(variant.tokens), binary: variant.binary });
  return { ...variant, tokens: [{ kind: 'text', text: encoded.text }], binary: true };
}

function applyTransform(transform: string, variant: PatternVariant): PatternVariant[] {
  switch (transform) {
    case 'contains':
      return [{ ...variant, tokens: wrapContains(variant.tokens) }];
    case 'startswith':
      return [{ ...variant, tokens: wrapEnd(variant.tokens) }];
    case 'endswith':
      return [{ ...variant, tokens: wrapStart(variant.tokens) }];
    case 'windash':
      return [{ ...variant, tokens: applyWindash(variant.tokens) }];
    case 'wide':
    case 'utf16le':
      return [encodeOnce(transform, variant, encodeUtf16le)];
    case 'utf16be':
      return [encodeOnce(transform, variant, encodeUtf16be)];
    case 'utf16':
      return [encodeOnce(transform, variant, encodeUtf16)];
    case 'base64':
    case 'base64offset': {
      if (!isPlain(variant.tokens)) {
        throw new UnsupportedRuleError('modifier:wildcard-encoding', transform);
      }
      const value = { text: plainText(variant.tokens), binary: variant.binary };
      const texts = transform === 'base64' ? [encodeBase64(value)] : encodeBase64Offsets(value);
      // Base64 text is case-significant, so encoded values always match case-sensitively.
      return texts.map((text) => ({
        tokens: [{ kind: 'text', text }],
        binary: false,
        cased: true,
      }));
    }
    default:
      throw new UnsupportedRuleError('modifier:unknown', transform);
  }
}

type Getter = (view: EventView) => string | undefined;

interface StringValue {
  isNull: boolean;
  sensitive: StringMatcher[];
  insensitive: StringMatcher[];
  /** Ids in the rule set's literal index (simple case-insensitive patterns). */
  literalIds: number[];
}

/** Where a detection item registers its simple patterns (see `literal-index.ts`). */
interface LiteralContext {
  index: LiteralIndex;
  slot: number;
  field: string | null;
}

/** `v`, `v*`, `*v` or `*v*` with a literal `v`; null for any other pattern. */
export function literalShape(
  tokens: readonly PatternToken[],
): { shape: LiteralShape; literal: string } | null {
  const [a, b, c, ...rest] = tokens;
  if (rest.length > 0) return null;
  if (a?.kind === 'text' && b === undefined) return { shape: 'equals', literal: a.text };
  if (a?.kind === 'text' && b?.kind === 'any' && c === undefined) {
    return { shape: 'prefix', literal: a.text };
  }
  if (a?.kind === 'any' && b?.kind === 'text' && c === undefined) {
    return { shape: 'suffix', literal: b.text };
  }
  if (a?.kind === 'any' && b?.kind === 'text' && c?.kind === 'any') {
    return { shape: 'contains', literal: b.text };
  }
  return null;
}

function compileStringValue(
  value: RuleScalar,
  plan: ModifierPlan,
  keyword: boolean,
  literals: LiteralContext | null,
): StringValue {
  const result: StringValue = { isNull: false, sensitive: [], insensitive: [], literalIds: [] };
  if (value === null) {
    if (plan.transforms.length > 0 || keyword) {
      throw new UnsupportedRuleError('detection:null-with-modifier');
    }
    return { ...result, isNull: true };
  }
  let variants: PatternVariant[] = [
    { tokens: parseSigmaString(String(value)), binary: false, cased: plan.cased },
  ];
  for (const transform of plan.transforms) {
    variants = variants.flatMap((variant) => applyTransform(transform, variant));
  }
  for (const variant of variants) {
    const tokens = normalizeTokens(keyword ? wrapContains(variant.tokens) : variant.tokens);
    if (variant.cased) {
      result.sensitive.push(compilePattern(tokens));
      continue;
    }
    const lowered = lowerTokens(tokens);
    const simple = literals === null ? null : literalShape(lowered);
    if (literals !== null && simple !== null) {
      const { index, slot, field } = literals;
      result.literalIds.push(index.register(slot, field, simple.shape, simple.literal));
    } else {
      result.insensitive.push(compilePattern(lowered));
    }
  }
  return result;
}

type LiteralLookup = (view: EventView) => ReadonlySet<number>;

function matchesString(
  value: StringValue,
  raw: string,
  view: EventView,
  lower: Getter,
  literalsOf: LiteralLookup | null,
): boolean {
  const { sensitive, insensitive, literalIds } = value;
  for (let i = 0; i < sensitive.length; i += 1) if (sensitive[i]?.(raw)) return true;
  if (literalIds.length > 0 && literalsOf !== null) {
    const found = literalsOf(view);
    if (found.size > 0) {
      for (let i = 0; i < literalIds.length; i += 1)
        if (found.has(literalIds[i] ?? -1)) return true;
    }
  }
  if (insensitive.length === 0) return false;
  const folded = lower(view) ?? '';
  for (let i = 0; i < insensitive.length; i += 1) if (insensitive[i]?.(folded)) return true;
  return false;
}

function stringTest(
  values: StringValue[],
  all: boolean,
  raw: Getter,
  lower: Getter,
  literalsOf: LiteralLookup | null,
): (view: EventView) => boolean {
  if (!all) {
    const merged: StringValue = {
      isNull: values.some((v) => v.isNull),
      sensitive: values.flatMap((v) => v.sensitive),
      insensitive: values.flatMap((v) => v.insensitive),
      literalIds: values.flatMap((v) => v.literalIds),
    };
    return (view) => {
      const text = raw(view);
      if (text === undefined) return merged.isNull;
      if (merged.isNull && text === '') return true;
      return matchesString(merged, text, view, lower, literalsOf);
    };
  }
  return (view) => {
    const text = raw(view);
    for (const value of values) {
      if (value.isNull) {
        if (text !== undefined && text !== '') return false;
      } else if (text === undefined || !matchesString(value, text, view, lower, literalsOf)) {
        return false;
      }
    }
    return true;
  };
}

/** A string item can only be true when one of its literal values matched. */
function stringRequirement(values: readonly StringValue[], all: boolean): Requirement {
  const literalOnly = (v: StringValue) =>
    !v.isNull && v.sensitive.length === 0 && v.insensitive.length === 0 && v.literalIds.length > 0;
  if (!all) return values.every(literalOnly) ? new Set(values.flatMap((v) => v.literalIds)) : null;
  // With `all`, every value must match, so any one value's literals are necessary.
  const first = values.find(literalOnly);
  return first ? new Set(first.literalIds) : null;
}

function combine<T>(items: T[], all: boolean, test: (item: T) => boolean): boolean {
  return all ? items.every(test) : items.some(test);
}

function requireStrings(values: RuleScalar[], modifier: string): string[] {
  return values.map((value) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && modifier === 're') return String(value);
    throw new UnsupportedRuleError(`modifier:${modifier}-value`, String(value));
  });
}

function parseIp(text: string | undefined): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (ipaddr.IPv4.isValidFourPartDecimal(trimmed)) return ipaddr.IPv4.parse(trimmed);
  if (!ipaddr.IPv6.isValid(trimmed)) return undefined;
  const v6 = ipaddr.IPv6.parse(trimmed);
  return v6.isIPv4MappedAddress() ? v6.toIPv4Address() : v6;
}

type Network = [ipaddr.IPv4 | ipaddr.IPv6, number];

function inNetwork(address: ipaddr.IPv4 | ipaddr.IPv6, [base, bits]: Network): boolean {
  return address.kind() === base.kind() && address.match(base, bits);
}

const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.length <= 64 && NUMERIC_TEXT.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function compare(operator: string, left: number, right: number): boolean {
  switch (operator) {
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    case 'gt':
      return left > right;
    default:
      return left >= right;
  }
}

/**
 * Compile one detection item. `key` is `field|mod|...`; an empty field (`'|all'`) or
 * `field: null` means a keyword item matched against `message`.
 */
export function compileDetectionItem(
  field: string | null,
  modifiers: readonly string[],
  rawValue: unknown,
  literalIndex?: LiteralIndex,
): DetectionItem {
  const plan = planModifiers(modifiers);
  const values = toValueList(rawValue);
  const keyword = field === null;
  const slot = field === null ? -1 : fieldSlot(field);
  const raw: Getter = field === null ? (view) => view.message : (view) => view.textAt(slot, field);
  const lower: Getter =
    field === null ? (view) => view.lowerMessage : (view) => view.lowerAt(slot, field);

  if (keyword && plan.type !== 'string' && plan.type !== 're') {
    throw new UnsupportedRuleError('modifier:keyword', plan.type);
  }

  switch (plan.type) {
    case 'string': {
      const literals = literalIndex === undefined ? null : { index: literalIndex, slot, field };
      const compiled = values.map((value) => compileStringValue(value, plan, keyword, literals));
      const literalsOf: LiteralLookup | null =
        literalIndex === undefined ? null : (view) => view.literals(literalIndex, slot, field);
      return {
        field,
        test: stringTest(compiled, plan.all, raw, lower, literalsOf),
        requires: literalIndex === undefined ? null : stringRequirement(compiled, plan.all),
      };
    }
    case 're': {
      const regexes: CompiledRegex[] = requireStrings(values, 're').map((pattern) =>
        compileRegex(pattern, plan.regexFlags),
      );
      return {
        field,
        test: (view) => {
          const text = raw(view);
          return text !== undefined && combine(regexes, plan.all, (re) => re.test(text));
        },
        requires: null,
      };
    }
    case 'cidr': {
      const networks: Network[] = requireStrings(values, 'cidr').map((text) => {
        try {
          return ipaddr.parseCIDR(text.trim());
        } catch {
          throw new UnsupportedRuleError('modifier:cidr-value', text);
        }
      });
      return {
        field,
        test: (view) => {
          const address = parseIp(raw(view));
          return address !== undefined && combine(networks, plan.all, (n) => inNetwork(address, n));
        },
        requires: null,
      };
    }
    case 'exists': {
      const [expected] = values;
      if (values.length !== 1 || typeof expected !== 'boolean') {
        throw new UnsupportedRuleError('modifier:exists-value', String(expected));
      }
      const name = field ?? '';
      return { field, test: (view) => view.has(name) === expected, requires: null };
    }
    case 'numeric': {
      const operator = plan.numericOperator ?? 'gte';
      const limits = values.map((value) => {
        const limit = toNumber(value);
        if (limit === undefined) {
          throw new UnsupportedRuleError('modifier:numeric-value', String(value));
        }
        return limit;
      });
      const name = field ?? '';
      return {
        field,
        test: (view) => {
          const number = toNumber(view.value(name));
          return (
            number !== undefined &&
            combine(limits, plan.all, (limit) => compare(operator, number, limit))
          );
        },
        requires: null,
      };
    }
    case 'fieldref': {
      const refs = requireStrings(values, 'fieldref');
      return {
        field,
        test: (view) => {
          const own = lower(view);
          if (own === undefined) return false;
          return combine(refs, plan.all, (ref) => view.lower(ref) === own);
        },
        requires: null,
      };
    }
  }
}

/** Split `field|mod|mod` into the field (`null` for `''`) and its modifiers. */
export function splitDetectionKey(key: string): { field: string | null; modifiers: string[] } {
  const [field = '', ...modifiers] = key.split('|');
  return { field: field === '' ? null : field, modifiers };
}
