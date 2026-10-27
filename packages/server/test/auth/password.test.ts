import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { parseArgon2idHash } from '../../src/auth/phc.js';
import { hashPassword, isDevPassword, verifyPassword } from '../../src/auth/password.js';
import { DEV_ADMIN_PASSWORD, DEV_ADMIN_PASSWORD_HASH } from '../../src/config.js';

describe('password hashing', () => {
  it('hashes with argon2id at the library defaults and verifies', async () => {
    const hash = await hashPassword('a long passphrase');
    expect(parseArgon2idHash(hash)).toEqual({ m: 65_536, t: 3, p: 4 });
    expect(await verifyPassword(hash, 'a long passphrase')).toBe(true);
    expect(await verifyPassword(hash, 'a long passphrasE')).toBe(false);
  });

  it('never throws for a hash it cannot read', async () => {
    expect(await verifyPassword('not a hash', 'x')).toBe(false);
  });

  it('recognizes the development password under any salt', async () => {
    expect(await isDevPassword(DEV_ADMIN_PASSWORD_HASH)).toBe(true);
    const resalted = await argon2.hash(DEV_ADMIN_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 1024,
      timeCost: 1,
    });
    expect(resalted).not.toBe(DEV_ADMIN_PASSWORD_HASH);
    expect(await isDevPassword(resalted)).toBe(true);
    expect(
      await isDevPassword(await argon2.hash('something else', { memoryCost: 1024, timeCost: 1 })),
    ).toBe(false);
  });

  it.each([
    ['argon2i', '$argon2i$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'],
    ['argon2d', '$argon2d$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'],
    ['an old version', '$argon2id$v=16$m=65536,t=3,p=4$c2FsdA$aGFzaA'],
    ['a missing parameter', '$argon2id$v=19$m=65536,t=3$c2FsdA$aGFzaA'],
    ['a repeated parameter', '$argon2id$v=19$m=65536,m=1,t=3$c2FsdA$aGFzaA'],
    ['an unknown parameter', '$argon2id$v=19$m=65536,t=3,x=4$c2FsdA$aGFzaA'],
    ['bcrypt', '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW'],
    ['trailing text', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA extra'],
  ])('rejects %s as a PHC argon2id hash', (_label, hash) => {
    expect(parseArgon2idHash(hash)).toBeUndefined();
  });
});
