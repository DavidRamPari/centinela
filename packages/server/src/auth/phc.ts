/**
 * Parsing argon2id hashes in PHC string format (`$argon2id$v=19$m=65536,t=3,p=4$salt$hash`)
 * without loading the native argon2 module, so configuration can be validated anywhere.
 */

export interface Argon2idParams {
  /** Memory in KiB. */
  m: number;
  /** Iterations. */
  t: number;
  /** Parallelism. */
  p: number;
}

/**
 * OWASP's minimum for argon2id (19 MiB, 2 iterations). Production refuses weaker hashes;
 * `npm run hash-password` uses the argon2 defaults (64 MiB, 3 iterations, 4 lanes).
 */
export const MIN_PRODUCTION_ARGON2: Readonly<Pick<Argon2idParams, 'm' | 't'>> = {
  m: 19_456,
  t: 2,
};

const B64 = '[A-Za-z0-9+/]+';
const PHC = new RegExp(`^\\$argon2id\\$v=19\\$([a-z=0-9,]{1,64})\\$${B64}\\$${B64}$`);

/** The cost parameters of an argon2id PHC string, or undefined when it is not one. */
export function parseArgon2idHash(hash: string): Argon2idParams | undefined {
  const match = PHC.exec(hash);
  if (!match?.[1]) return undefined;
  const params = new Map<string, number>();
  for (const part of match[1].split(',')) {
    const [key, value] = part.split('=');
    if (key === undefined || value === undefined || !/^\d{1,10}$/.test(value)) return undefined;
    if (params.has(key)) return undefined;
    params.set(key, Number(value));
  }
  const m = params.get('m');
  const t = params.get('t');
  const p = params.get('p');
  if (params.size !== 3 || m === undefined || t === undefined || p === undefined) {
    return undefined;
  }
  return { m, t, p };
}
