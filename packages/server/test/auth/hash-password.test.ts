import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashPasswordCommand, type HashPasswordIo } from '../../src/auth/hash-password.js';
import { verifyPassword } from '../../src/auth/password.js';
import { DEV_ADMIN_PASSWORD } from '../../src/config.js';

const serverRoot = fileURLToPath(new URL('../..', import.meta.url));

function fakeIo(answers: string[], interactive = true) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const io: HashPasswordIo = {
    interactive,
    readPassword: (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(answers.shift() ?? '');
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { io, out, err, prompts };
}

const HASH_LINE = /^ADMIN_PASSWORD_HASH='(\$argon2id\$[^']+)'\n$/;

describe('npm run hash-password', () => {
  it('asks twice on a terminal and prints a quoted .env line', async () => {
    const { io, out, prompts } = fakeIo(['correct horse battery', 'correct horse battery']);
    expect(await hashPasswordCommand([], io)).toBe(0);
    expect(prompts).toEqual(['Password: ', 'Repeat password: ']);
    const hash = HASH_LINE.exec(out.join(''))?.[1] ?? '';
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
  });

  it.each([
    ['mismatched passwords', ['correct horse battery', 'correct horse batterY'], 'do not match'],
    ['a short password', ['short', 'short'], 'at least 12'],
    ['the development password', [DEV_ADMIN_PASSWORD, DEV_ADMIN_PASSWORD], 'development password'],
  ])('refuses %s', async (_label, answers, message) => {
    const { io, out, err } = fakeIo(answers);
    expect(await hashPasswordCommand([], io)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).toContain(message);
  });

  it('never takes the password as an argument', async () => {
    const { io, err } = fakeIo([]);
    expect(await hashPasswordCommand(['hunter2hunter2'], io)).toBe(2);
    expect(err.join('')).toContain('takes no arguments');
    expect(err.join('')).not.toContain('hunter2hunter2');
  });

  it('reads the first line of piped input', () => {
    const result = spawnSync(
      process.execPath,
      ['--conditions=@centinela/source', '--import', 'tsx', 'src/auth/cli/hash-password.ts'],
      { cwd: serverRoot, encoding: 'utf8', input: 'piped passphrase 42\nignored second line\n' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(HASH_LINE);
  });
});
