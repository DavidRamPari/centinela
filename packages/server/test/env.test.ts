import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../src/env.js';

describe('loadDotEnv', () => {
  const keys = ['CENTINELA_TEST_FROM_FILE', 'CENTINELA_TEST_PRESET'];
  afterEach(() => {
    for (const key of keys) Reflect.deleteProperty(process.env, key);
  });

  it('loads variables from the file without overriding the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'centinela-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'CENTINELA_TEST_FROM_FILE=file\nCENTINELA_TEST_PRESET=file\n');
    process.env.CENTINELA_TEST_PRESET = 'environment';
    loadDotEnv(file);
    expect(process.env.CENTINELA_TEST_FROM_FILE).toBe('file');
    expect(process.env.CENTINELA_TEST_PRESET).toBe('environment');
  });

  it('does nothing when the file is missing', () => {
    expect(() => loadDotEnv(join(tmpdir(), 'centinela-missing', '.env'))).not.toThrow();
  });
});
