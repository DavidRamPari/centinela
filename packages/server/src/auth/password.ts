/** Password hashing with argon2id (the native `argon2` module). */
import argon2 from 'argon2';
import { DEV_ADMIN_PASSWORD } from '../config.js';

/** `npm run hash-password` refuses shorter passwords. */
export const MIN_PASSWORD_LENGTH = 12;

/** argon2id with the library defaults: 64 MiB, 3 iterations, 4 lanes. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/** False for a wrong password and for a hash argon2 cannot read (never throws). */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * True when `hash` was made from the development password, even with another salt.
 * Production refuses to start in that case (the configuration only catches the exact
 * development hash, because checking a password needs the asynchronous argon2 module).
 */
export function isDevPassword(hash: string): Promise<boolean> {
  return verifyPassword(hash, DEV_ADMIN_PASSWORD);
}
