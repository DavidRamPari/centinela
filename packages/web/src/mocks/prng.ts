/** Seeded randomness for deterministic fixtures (never Math.random). */

export type Rng = () => number;

/** mulberry32: small, fast, good enough for fixtures. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

function hex(rng: Rng, digits: number): string {
  let out = '';
  for (let i = 0; i < digits; i += 1) out += Math.floor(rng() * 16).toString(16);
  return out;
}

/** UUIDv7 (RFC 9562): 48-bit millisecond timestamp, version 7, variant 10, random rest. */
export function uuidv7(ms: number, rng: Rng): string {
  const time = Math.max(0, Math.floor(ms)).toString(16).padStart(12, '0').slice(-12);
  const variant = (8 + Math.floor(rng() * 4)).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex(rng, 3)}-${variant}${hex(rng, 3)}-${hex(rng, 12)}`;
}
