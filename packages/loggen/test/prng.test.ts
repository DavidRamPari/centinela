import { describe, expect, it } from 'vitest';
import { deriveSeed, fnv1a, mulberry32, Random } from '../src/prng.js';

describe('mulberry32', () => {
  it('is deterministic and stays in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const values = Array.from({ length: 1000 }, () => a());
    expect(values).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    // The first output for seed 42 pins the algorithm.
    expect(mulberry32(42)()).toBe(0.6011037519201636);
  });

  it('gives different sequences for different seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('is roughly uniform', () => {
    const next = mulberry32(7);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 100_000; i += 1) {
      const bucket = Math.floor(next() * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const count of buckets) expect(Math.abs(count - 10_000)).toBeLessThan(500);
  });
});

describe('derived streams', () => {
  it('are stable per label and differ between labels and seeds', () => {
    expect(deriveSeed(42, 'web')).toBe(deriveSeed(42, 'web'));
    expect(deriveSeed(42, 'web')).not.toBe(deriveSeed(42, 'auth'));
    expect(deriveSeed(42, 'web')).not.toBe(deriveSeed(43, 'web'));
    expect(fnv1a('')).toBe(0x811c9dc5);
  });
});

describe('Random helpers', () => {
  const rng = new Random(1);

  it('int() stays within bounds, both inclusive', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i += 1) seen.add(rng.int(3, 5));
    expect([...seen].sort()).toEqual([3, 4, 5]);
  });

  it('weighted() honors weights, including undefined items', () => {
    const counts = new Map<string | undefined, number>();
    for (let i = 0; i < 10_000; i += 1) {
      const item = rng.weighted(['a', undefined, 'c'], [1, 1, 0]);
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    expect(counts.get('c')).toBeUndefined();
    expect(counts.get(undefined)).toBeGreaterThan(4_000);
  });

  it('exponential() has the requested mean', () => {
    let sum = 0;
    for (let i = 0; i < 50_000; i += 1) sum += rng.exponential(10);
    expect(sum / 50_000).toBeGreaterThan(9.7);
    expect(sum / 50_000).toBeLessThan(10.3);
  });

  it('pick() and weighted() refuse empty lists', () => {
    expect(() => rng.pick([])).toThrow();
    expect(() => rng.weighted([], [])).toThrow();
  });
});
