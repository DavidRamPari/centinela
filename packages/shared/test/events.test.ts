import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_LENGTH,
  fieldValueSchema,
  logSourceSchema,
  normalizedEventSchema,
} from '../src/index.js';
import { validEvent } from './fixtures.js';

describe('normalizedEventSchema', () => {
  it('parses a valid event', () => {
    expect(normalizedEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it('accepts IPv6 source addresses and events without optional fields', () => {
    const { user: _user, srcPort: _srcPort, ...rest } = validEvent;
    expect(normalizedEventSchema.safeParse({ ...rest, srcIp: '2001:db8::1' }).success).toBe(true);
  });

  it.each([
    ['a non-UUID id', { id: 'not-a-uuid' }],
    ['a timestamp with an offset instead of UTC', { ts: '2026-10-21T03:12:05-05:00' }],
    ['an unknown source', { source: 'windows_eventlog' }],
    ['an unknown category', { category: 'kernel' }],
    ['an unknown outcome', { outcome: 'maybe' }],
    ['an empty host', { host: '' }],
    ['a bracketed IPv6 address', { srcIp: '[2001:db8::1]' }],
    ['an out-of-range port', { srcPort: 70000 }],
    ['a message above the length cap', { message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }],
    ['a nested object in fields', { fields: { 'event.action': { nested: true } } }],
  ])('rejects %s', (_label, patch) => {
    expect(normalizedEventSchema.safeParse({ ...validEvent, ...patch }).success).toBe(false);
  });
});

describe('logSourceSchema and fieldValueSchema', () => {
  it('accepts partial logsources and scalar field values', () => {
    expect(logSourceSchema.parse({ category: 'webserver' })).toEqual({ category: 'webserver' });
    for (const value of ['x', 1, true, null]) {
      expect(fieldValueSchema.safeParse(value).success).toBe(true);
    }
  });

  it('rejects empty logsource values and non-scalar field values', () => {
    expect(logSourceSchema.safeParse({ product: '' }).success).toBe(false);
    expect(fieldValueSchema.safeParse(['a']).success).toBe(false);
    expect(fieldValueSchema.safeParse(undefined).success).toBe(false);
  });
});
