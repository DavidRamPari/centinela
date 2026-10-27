/**
 * `npm run hash-password` (entry point: `cli/hash-password.ts`).
 *
 * Prints an argon2id hash for `ADMIN_PASSWORD_HASH`. The password is never taken from the
 * command line (shell history, process list): it is typed twice without echo on a
 * terminal, or read from the first line of standard input when piped:
 *
 *   printf '%s' "$PASSWORD" | npm run hash-password --silent
 *
 * The output is one `ADMIN_PASSWORD_HASH='…'` line for `.env`; the single quotes keep
 * the `$` characters literal for Docker Compose and shells.
 */
import { DEV_ADMIN_PASSWORD } from '../config.js';
import { MIN_PASSWORD_LENGTH, hashPassword } from './password.js';

export const USAGE = `Usage: npm run hash-password

Prints ADMIN_PASSWORD_HASH for the dashboard sign-in (argon2id). Type the password twice,
or pipe it on standard input:

  printf '%s' "$PASSWORD" | npm run hash-password --silent

Passwords need at least ${MIN_PASSWORD_LENGTH} characters.
`;

export interface HashPasswordIo {
  /** True when standard input is a terminal (prompt twice, no echo). */
  interactive: boolean;
  /** Read one password; `prompt` is shown on a terminal. */
  readPassword(prompt: string): Promise<string>;
  out(text: string): void;
  err(text: string): void;
}

/** Returns the exit code: 0 success, 1 rejected password, 2 bad arguments. */
export async function hashPasswordCommand(argv: string[], io: HashPasswordIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(USAGE);
    return 0;
  }
  if (argv.length > 0) {
    io.err(
      `hash-password takes no arguments (never put a password on the command line).\n\n${USAGE}`,
    );
    return 2;
  }
  const password = await io.readPassword('Password: ');
  if (io.interactive && (await io.readPassword('Repeat password: ')) !== password) {
    io.err('The passwords do not match.\n');
    return 1;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    io.err(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.\n`);
    return 1;
  }
  if (password === DEV_ADMIN_PASSWORD) {
    io.err('That is the development password; production refuses it. Choose another one.\n');
    return 1;
  }
  io.out(`ADMIN_PASSWORD_HASH='${await hashPassword(password)}'\n`);
  return 0;
}
