import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generate, groundTruthJson, mergeIntervals } from '../src/generate.js';
import { formatAccessTime, formatSyslogTime } from '../src/output.js';
import { SCENARIOS } from '../src/scenarios.js';

const START_MS = Date.parse('2026-10-20T00:00:00Z');

function digest(result: ReturnType<typeof generate>): string {
  const hash = createHash('sha256');
  for (const file of result.files) hash.update(file.path).update('\0').update(file.content);
  hash.update(groundTruthJson(result.groundTruth));
  return hash.digest('hex');
}

describe('determinism', () => {
  it('gives byte-identical output for the same seed', () => {
    const a = generate({ seed: 42, days: 3, startMs: START_MS, small: true });
    const b = generate({ seed: 42, days: 3, startMs: START_MS, small: true });
    expect(a.files.map((f) => f.path)).toEqual(b.files.map((f) => f.path));
    for (const [i, file] of a.files.entries()) expect(file.content).toBe(b.files[i]?.content);
    expect(digest(a)).toBe(digest(b));
  });

  it('gives different output for different seeds', () => {
    const a = generate({ seed: 42, days: 3, startMs: START_MS, small: true });
    const b = generate({ seed: 43, days: 3, startMs: START_MS, small: true });
    expect(digest(a)).not.toBe(digest(b));
    for (const [i, file] of a.files.entries()) expect(file.content).not.toBe(b.files[i]?.content);
  });

  it('is deterministic for the full default run too', () => {
    const options = { seed: 42, days: 3, startMs: START_MS, small: false };
    expect(digest(generate(options))).toBe(digest(generate(options)));
  });
});

describe('default run', () => {
  const started = performance.now();
  const result = generate({ seed: 42, days: 3, startMs: START_MS, small: false });
  const elapsed = performance.now() - started;

  it('writes about 200,000 lines in well under 10 seconds', () => {
    expect(result.lines.length).toBeGreaterThan(180_000);
    expect(result.lines.length).toBeLessThan(230_000);
    expect(elapsed).toBeLessThan(10_000);
  });

  it('writes auth.log for every host and access.log for the web servers', () => {
    expect(result.files.map((f) => f.path)).toEqual([
      'bastion-01/auth.log',
      'web-01/auth.log',
      'web-01/access.log',
      'web-02/auth.log',
      'web-02/access.log',
      'db-01/auth.log',
    ]);
    for (const file of result.files) {
      expect(file.content.endsWith('\n')).toBe(true);
      expect(file.content.split('\n')).toHaveLength(file.lineCount + 1);
    }
  });

  it('orders every file by time', () => {
    for (const file of result.files) {
      const lines = result.lines.filter((l) => l.host === file.host && l.file === file.file);
      for (let i = 1; i < lines.length; i += 1) {
        expect((lines[i]?.tsUs ?? 0) >= (lines[i - 1]?.tsUs ?? 0)).toBe(true);
      }
    }
  });

  it('covers the requested days with background traffic', () => {
    const background = result.lines.filter((l) => l.scenario === null).map((l) => l.tsUs / 1000);
    const first = background.reduce((a, b) => Math.min(a, b), Infinity);
    const last = background.reduce((a, b) => Math.max(a, b), -Infinity);
    expect(first).toBeLessThan(START_MS + 60_000);
    expect(last).toBeGreaterThan(START_MS + 3 * 86_400_000 - 3_600_000);
  });

  it('uses only documentation, benchmarking and private addresses', () => {
    const allowed = /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|198\.1[89]\.|10\.20\.)/;
    const ips = new Set<string>();
    for (const line of result.lines) {
      for (const match of line.text.matchAll(/(?<![\w./])(\d{1,3}(?:\.\d{1,3}){3})\b/g))
        ips.add(match[1] ?? '');
    }
    const outside = [...ips].filter((ip) => !allowed.test(ip) && ip !== '0.0.0.0');
    expect(outside).toEqual([]);
  });

  it('uses only reserved .example domains in URLs', () => {
    const hosts = new Set<string>();
    for (const line of result.lines) {
      for (const match of line.text.matchAll(/(?:https?|ldap):\/\/([A-Za-z0-9.-]+)/g))
        hosts.add(match[1] ?? '');
    }
    const real = [...hosts].filter(
      (h) => !h.endsWith('.example') && !/^\d+\.\d+\.\d+\.\d+$/.test(h),
    );
    expect(real).toEqual([]);
  });

  it('never calls Math.random', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../src/', import.meta.url);
    for (const name of readdirSync(dir)) {
      expect(readFileSync(new URL(name, dir), 'utf8'), name).not.toMatch(/Math\.random\s*\(/);
    }
  });
});

describe('ground truth', () => {
  const { groundTruth } = generate({ seed: 42, days: 3, startMs: START_MS, small: false });

  it('records the run parameters', () => {
    expect(groundTruth).toMatchObject({
      seed: 42,
      start: '2026-10-20T00:00:00.000Z',
      days: 3,
      small: false,
    });
  });

  it('lists every scenario of ARCHITECTURE §4.3 with its technique and expected rules', () => {
    const byId = Object.fromEntries(groundTruth.scenarios.map((s) => [s.id, s]));
    expect(Object.keys(byId)).toEqual([
      'ssh-bruteforce',
      'password-spray',
      'bruteforce-success',
      'post-compromise',
      'privileged-user',
      'sudo-not-allowed',
      'web-recon',
      'sqli',
      'path-traversal',
      'log4shell-probe',
      'webshell',
    ]);
    expect(byId['ssh-bruteforce']).toMatchObject({
      host: 'bastion-01',
      techniques: ['T1110.001'],
      start: '2026-10-21T03:12:00.000Z',
      entities: { ips: ['203.0.113.45'], users: ['root', 'admin'] },
      expected: ['centinela-ssh-bruteforce'],
    });
    expect(byId['password-spray']?.expected).toEqual(['centinela-ssh-password-spraying']);
    expect(byId['bruteforce-success']?.expected).toEqual([
      'centinela-ssh-bruteforce',
      'centinela-ssh-bruteforce-success',
    ]);
    expect(byId['post-compromise']?.expected).toEqual([
      'lnx_shell_susp_commands',
      'lnx_shell_susp_rev_shells',
    ]);
    expect(byId['privileged-user']?.expected).toEqual([
      'lnx_privileged_user_creation',
      'centinela-privileged-account-created',
    ]);
    expect(byId['sudo-not-allowed']).toMatchObject({
      host: 'db-01',
      expected: ['centinela-sudo-user-not-in-sudoers'],
    });
    expect(byId['web-recon']?.expected).toEqual([
      'web_susp_useragents',
      'centinela-web-scanning-burst',
    ]);
    expect(byId.sqli?.expected).toEqual([
      'web_sql_injection_in_access_logs',
      'web_susp_useragents',
    ]);
    expect(byId['path-traversal']).toMatchObject({
      host: 'web-02',
      expected: ['web_path_traversal_exploitation_attempt'],
    });
    expect(byId['log4shell-probe']?.expected).toEqual(['web_jndi_exploit']);
    expect(byId.webshell?.expected).toEqual(['web_win_webshells_in_access_logs']);
  });

  it('uses only the Centinela rule names of ARCHITECTURE §6.1 and vendored SigmaHQ files', async () => {
    const { existsSync, readdirSync } = await import('node:fs');
    const centinela = new Set([
      'centinela-ssh-bruteforce',
      'centinela-ssh-password-spraying',
      'centinela-ssh-bruteforce-success',
      'centinela-privileged-account-created',
      'centinela-web-scanning-burst',
      'centinela-sudo-user-not-in-sudoers',
    ]);
    const sigmaRoot = new URL('../../../rules/sigma/', import.meta.url);
    const sigmaFiles = new Set<string>();
    for (const dir of ['linux/builtin', 'web/webserver_generic']) {
      for (const name of readdirSync(new URL(`${dir}/`, sigmaRoot)))
        sigmaFiles.add(name.replace(/\.yml$/, ''));
    }
    expect(existsSync(sigmaRoot)).toBe(true);
    for (const scenario of groundTruth.scenarios) {
      for (const name of scenario.expected) {
        expect(centinela.has(name) || sigmaFiles.has(name), name).toBe(true);
      }
    }
  });

  it('gives ordered, valid time ranges inside the run', () => {
    for (const s of groundTruth.scenarios) {
      expect(Date.parse(s.start)).toBeLessThan(Date.parse(s.end));
      expect(Date.parse(s.start)).toBeGreaterThan(START_MS);
      expect(Date.parse(s.end)).toBeLessThan(START_MS + 3 * 86_400_000);
      expect(s.techniques.every((t) => /^T\d{4}(\.\d{3})?$/.test(t))).toBe(true);
    }
  });

  it('matches the scenario catalogue', () => {
    expect(groundTruth.scenarios.map((s) => s.id)).toEqual(SCENARIOS.map((s) => s.id));
  });
});

describe('--small', () => {
  const small = generate({ seed: 42, days: 3, startMs: START_MS, small: true });
  const full = generate({ seed: 42, days: 3, startMs: START_MS, small: false });

  it('keeps the scenarios and their timing, with far less background', () => {
    expect(small.groundTruth.scenarios).toEqual(full.groundTruth.scenarios);
    expect(small.groundTruth.small).toBe(true);
    expect(small.lines.length).toBeLessThan(15_000);
    const scenarioLines = (r: typeof small) =>
      r.lines.filter((l) => l.scenario !== null).map((l) => l.text);
    expect(scenarioLines(small)).toEqual(scenarioLines(full));
  });

  it('puts background lines only near a scenario', () => {
    const ranges = small.groundTruth.scenarios.map(
      (s) => [Date.parse(s.start), Date.parse(s.end)] as const,
    );
    for (const line of small.lines.filter((l) => l.scenario === null)) {
      const ms = line.tsUs / 1000;
      const near = ranges.some(([from, to]) => ms >= from - 6 * 60_000 && ms <= to + 100 * 60_000);
      expect(near, line.text).toBe(true);
    }
  });
});

describe('options', () => {
  it('scales the schedule with --days and moves it with --start', () => {
    const one = generate({
      seed: 1,
      days: 1,
      startMs: Date.parse('2027-03-01T00:00:00Z'),
      small: true,
    });
    for (const s of one.groundTruth.scenarios) {
      expect(Date.parse(s.start)).toBeGreaterThanOrEqual(Date.parse('2027-03-01T00:00:00Z'));
      expect(Date.parse(s.end)).toBeLessThan(Date.parse('2027-03-02T00:00:00Z'));
    }
  });

  it.each([
    [{ seed: -1 }, /seed/],
    [{ seed: 1.5 }, /seed/],
    [{ days: 0 }, /days/],
    [{ days: 31 }, /days/],
    [{ startMs: Number.NaN }, /start/],
  ])('rejects %j', (override, message) => {
    expect(() =>
      generate({ seed: 1, days: 1, startMs: START_MS, small: true, ...override }),
    ).toThrow(message);
  });
});

describe('helpers', () => {
  it('merges overlapping intervals', () => {
    expect(
      mergeIntervals([
        { fromMs: 10, toMs: 20 },
        { fromMs: 0, toMs: 5 },
        { fromMs: 15, toMs: 30 },
        { fromMs: 30, toMs: 31 },
      ]),
    ).toEqual([
      { fromMs: 0, toMs: 5 },
      { fromMs: 10, toMs: 31 },
    ]);
  });

  it('formats Lima-time timestamps', () => {
    const us = Date.parse('2026-10-21T03:12:00.123Z') * 1000 + 456;
    expect(formatSyslogTime(us)).toBe('2026-10-20T22:12:00.123456-05:00');
    expect(formatAccessTime(Date.parse('2026-10-21T03:12:00Z'))).toBe('20/Oct/2026:22:12:00 -0500');
  });
});
