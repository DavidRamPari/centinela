import { describe, expect, it } from 'vitest';
import { EventView } from '../../src/detection/event-view.js';
import { LiteralIndex, type LiteralShape } from '../../src/detection/sigma/literal-index.js';
import { createLogsourceRouter } from '../../src/detection/routing.js';

function naive(shape: LiteralShape, literal: string, value: string): boolean {
  switch (shape) {
    case 'equals':
      return value === literal;
    case 'prefix':
      return value.startsWith(literal);
    case 'suffix':
      return value.endsWith(literal);
    case 'contains':
      return value.includes(literal);
  }
}

describe('LiteralIndex', () => {
  it('finds equal, prefix, suffix and substring literals in one scan', () => {
    const index = new LiteralIndex();
    const equals = index.register(0, 'Image', 'equals', 'cmd.exe');
    const prefix = index.register(0, 'Image', 'prefix', 'c:\\windows\\');
    const suffix = index.register(0, 'Image', 'suffix', '\\cmd.exe');
    const contains = index.register(0, 'Image', 'contains', 'system32');
    const found = index.match(0, 'c:\\windows\\system32\\cmd.exe');
    expect([...found].sort()).toEqual([prefix, suffix, contains].sort());
    expect(index.match(0, 'cmd.exe').has(equals)).toBe(true);
  });

  it('gives the same id to the same literal and keeps fields apart', () => {
    const index = new LiteralIndex();
    const a = index.register(0, 'Image', 'contains', 'x');
    expect(index.register(0, 'Image', 'contains', 'x')).toBe(a);
    const b = index.register(1, 'CommandLine', 'contains', 'x');
    expect(b).not.toBe(a);
    expect(index.match(1, 'x').has(a)).toBe(false);
    expect(index.fieldOf(b)).toEqual({ slot: 1, field: 'CommandLine' });
  });

  it('agrees with naive matching on overlapping literals (Aho–Corasick failure links)', () => {
    let seed = 11;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const word = (max: number) =>
      Array.from({ length: 1 + (next() % max) }, () => 'abc'[next() % 3]).join('');
    const shapes: LiteralShape[] = ['equals', 'prefix', 'suffix', 'contains'];
    const index = new LiteralIndex();
    const literals = Array.from({ length: 200 }, () => {
      const shape = shapes[next() % 4] ?? 'contains';
      const literal = word(5);
      return { shape, literal, id: index.register(0, 'f', shape, literal) };
    });
    for (let round = 0; round < 500; round += 1) {
      const value = word(20);
      const found = index.match(0, value);
      for (const { shape, literal, id } of literals) {
        expect(found.has(id), `${shape} ${literal} in ${value}`).toBe(naive(shape, literal, value));
      }
    }
  });

  it('is cached per event and field by the view', () => {
    const index = new LiteralIndex();
    const id = index.register(0, 'f', 'contains', 'needle');
    const view = new EventView({ message: 'a needle', fields: { f: 'no' } });
    expect(view.literals(index, 0, 'f').has(id)).toBe(false);
    expect(view.literals(index, -1, null).size).toBe(0);
    const keyword = index.register(-1, null, 'contains', 'needle');
    const fresh = new EventView({ message: 'a needle', fields: {} });
    expect(fresh.literals(index, -1, null).has(keyword)).toBe(true);
  });
});

describe('logsource routing (ARCHITECTURE §5.2)', () => {
  const rules = [
    { logsource: { product: 'linux' }, rule: 'linux' },
    { logsource: { product: 'linux', service: 'sshd' }, rule: 'sshd' },
    { logsource: { product: 'linux', service: 'sudo' }, rule: 'sudo' },
    { logsource: { category: 'webserver' }, rule: 'webserver' },
    { logsource: { service: 'nginx' }, rule: 'nginx' },
    { logsource: { product: 'windows', category: 'process_creation' }, rule: 'proc' },
    { logsource: {}, rule: 'everything' },
  ];
  const router = createLogsourceRouter(rules);

  it('applies a rule when every key it sets matches one logsource of the event', () => {
    expect(
      router.route([
        { product: 'linux', service: 'sshd' },
        { product: 'linux', service: 'auth' },
      ]),
    ).toEqual(['linux', 'sshd', 'everything']);
    expect(router.route([{ category: 'webserver' }, { service: 'nginx' }])).toEqual([
      'webserver',
      'nginx',
      'everything',
    ]);
  });

  it('requires all of a rule’s keys within the same logsource entry', () => {
    expect(router.route([{ product: 'windows' }, { category: 'process_creation' }])).toEqual([
      'everything',
    ]);
    expect(router.route([{ product: 'windows', category: 'process_creation' }])).toEqual([
      'proc',
      'everything',
    ]);
  });

  it('compares case-insensitively', () => {
    expect(router.route([{ product: 'Linux', service: 'SUDO' }])).toEqual([
      'linux',
      'sudo',
      'everything',
    ]);
  });

  it('returns the same array for the same event shape', () => {
    const shape = [{ category: 'webserver' }, { service: 'apache' }];
    expect(router.route(shape)).toBe(
      router.route([{ category: 'webserver' }, { service: 'apache' }]),
    );
  });
});
