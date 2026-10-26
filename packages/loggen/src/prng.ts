/**
 * Seeded pseudo-random numbers. `Math.random` is never used: the same seed must produce
 * byte-identical output. mulberry32 is a small, fast 32-bit generator; it is not
 * cryptographic, which is fine for demo data.
 */

/** mulberry32: returns a function yielding floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string (32-bit). */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Independent stream per component (`seed` + label), so adding a scenario or changing
 * one generator does not shift the numbers every other generator sees.
 */
export function deriveSeed(seed: number, label: string): number {
  let h = (seed ^ fnv1a(label)) >>> 0;
  // Final avalanche (murmur3 fmix32) so nearby seeds give unrelated streams.
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export class Random {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  static for(seed: number, label: string): Random {
    return new Random(deriveSeed(seed, label));
  }

  /** Float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('pick() from an empty list');
    return item;
  }

  /** Pick with weights (same length as `items`). */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0) throw new Error('weighted() from an empty list');
    const total = weights.reduce((sum, w) => sum + w, 0);
    let r = this.next() * total;
    let index = 0;
    while (index < items.length - 1) {
      r -= weights[index] ?? 0;
      if (r < 0) break;
      index += 1;
    }
    return items[index] as T;
  }

  /** Exponentially distributed value with the given mean (Poisson inter-arrival times). */
  exponential(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  /** Lower-case hex string of `length` characters. */
  hex(length: number): string {
    let out = '';
    for (let i = 0; i < length; i += 1) out += '0123456789abcdef'.charAt(this.int(0, 15));
    return out;
  }

  /** Characters from `alphabet`. */
  chars(length: number, alphabet: string): string {
    let out = '';
    for (let i = 0; i < length; i += 1) out += alphabet.charAt(this.int(0, alphabet.length - 1));
    return out;
  }
}
