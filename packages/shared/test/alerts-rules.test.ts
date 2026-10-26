import { describe, expect, it } from 'vitest';
import { LEVEL_WEIGHT, LEVELS, alertSchema, ruleMetaSchema } from '../src/index.js';
import { validAlert, validRule } from './fixtures.js';

describe('alertSchema', () => {
  it('parses a valid alert', () => {
    expect(alertSchema.parse(validAlert)).toEqual(validAlert);
  });

  it.each([
    ['an unknown level', { level: 'severe' }],
    ['an unknown status', { status: 'open' }],
    ['an unknown resolution', { resolution: 'duplicate' }],
    ['a malformed technique id', { techniques: ['T110'] }],
    ['a zero count', { count: 0 }],
    ['an unknown license', { license: 'GPL-3.0' }],
    ['a non-URL rule link', { ruleUrl: 'not a url' }],
    ['entities with an invalid IP', { entities: { ips: ['999.1.1.1'], users: [], hosts: [] } }],
  ])('rejects %s', (_label, patch) => {
    expect(alertSchema.safeParse({ ...validAlert, ...patch }).success).toBe(false);
  });

  it('orders levels by weight', () => {
    const weights = LEVELS.map((level) => LEVEL_WEIGHT[level]);
    expect(weights).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('ruleMetaSchema', () => {
  it('parses a valid rule', () => {
    expect(ruleMetaSchema.parse(validRule)).toEqual(validRule);
  });

  it.each([
    ['a non-UUID id', { id: 'rule-1' }],
    ['an unknown origin', { origin: 'community' }],
    ['an unknown type', { type: 'yara' }],
    ['a missing title', { title: '' }],
    ['lower-case technique ids', { techniques: ['t1059.004'] }],
    ['a missing supported flag', { supported: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(ruleMetaSchema.safeParse({ ...validRule, ...patch }).success).toBe(false);
  });
});
