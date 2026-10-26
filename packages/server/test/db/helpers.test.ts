import type { RuleMeta } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/db/cursor.js';
import { prefixTsQuery } from '../../src/db/events-read.js';
import { ruleIdsByName } from '../../src/db/ground-truth.js';
import { logsourcesFor } from '../../src/db/logsources.js';
import { resolveTimeRange } from '../../src/routes/query.js';

describe('keyset cursors', () => {
  const position = { ts: '2026-10-21T03:12:00.123Z', id: '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f' };

  it('round-trips a position as base64url', () => {
    const cursor = encodeCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(position);
  });

  it.each([
    ['no separator', 'abc'],
    ['an invalid time', 'yesterday|01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f'],
    ['an invalid id', '2026-10-21T03:12:00.123Z|1 OR 1=1'],
    ['an extra separator', '2026-10-21T03:12:00.123Z|01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f|x'],
  ])('rejects %s', (_name, text) => {
    expect(decodeCursor(Buffer.from(text).toString('base64url'))).toBeUndefined();
  });
});

describe('prefixTsQuery', () => {
  it.each([
    ['sqlmap', "'sqlmap':*"],
    ['  Failed   password ', "'Failed':* & 'password':*"],
    ["it's", "'it''s':*"],
    ['a\\b', "'a\\\\b':*"],
    ["'); DROP TABLE events;--", "''');':* & 'DROP':* & 'TABLE':* & 'events;--':*"],
    ['', ''],
  ])('quotes every word of %j as a prefix term', (text, expected) => {
    expect(prefixTsQuery(text)).toBe(expected);
  });
});

describe('logsourcesFor', () => {
  it.each([
    [
      'linux_auth',
      'ssh_login',
      { 'process.name': 'sshd' },
      [
        { product: 'linux', service: 'sshd' },
        { product: 'linux', service: 'auth' },
      ],
    ],
    [
      'linux_auth',
      'sudo_command',
      { 'process.name': 'sudo' },
      [
        { product: 'linux', service: 'sudo' },
        { product: 'linux', service: 'auth' },
      ],
    ],
    ['linux_auth', 'other', {}, [{ product: 'linux', service: 'auth' }]],
    ['nginx_access', 'http_request', {}, [{ category: 'webserver' }, { service: 'nginx' }]],
    ['apache_access', 'http_request', {}, [{ category: 'webserver' }, { service: 'apache' }]],
    ['sysmon', 'process_start', {}, [{ product: 'windows', category: 'process_creation' }]],
    ['sysmon', 'other', {}, [{ product: 'windows' }]],
  ] as const)('rebuilds %s/%s', (source, action, fields, expected) => {
    expect(logsourcesFor(source, action, fields)).toEqual(expected);
  });
});

describe('resolveTimeRange', () => {
  const now = new Date('2026-10-26T12:00:00Z');

  it('defaults to the last 24 hours', () => {
    expect(resolveTimeRange({}, now)).toEqual({ from: new Date('2026-10-25T12:00:00Z'), to: now });
  });

  it('defaults `to` to now when only `from` is given (S3-03)', () => {
    const range = resolveTimeRange({ from: '2026-10-01T00:00:00Z' }, now);
    expect(range).toEqual({ from: new Date('2026-10-01T00:00:00Z'), to: now });
  });

  it('counts back 24 hours from an explicit `to`', () => {
    const range = resolveTimeRange({ to: '2026-10-21T00:00:00-05:00' }, now);
    expect(range).toEqual({
      from: new Date('2026-10-20T05:00:00Z'),
      to: new Date('2026-10-21T05:00:00Z'),
    });
  });
});

describe('ruleIdsByName', () => {
  const rule = (id: string, name: string | null, path: string) => ({ id, name, path }) as RuleMeta;

  it('maps Centinela names and SigmaHQ file names to ids', () => {
    const ids = ruleIdsByName([
      rule('a', 'centinela-ssh-bruteforce', 'rules/correlation/ssh_bruteforce.yml'),
      rule('b', null, 'rules/sigma/web/webserver_generic/web_susp_useragents.yml'),
    ]);
    expect(ids.get('centinela-ssh-bruteforce')).toBe('a');
    expect(ids.get('web_susp_useragents')).toBe('b');
    expect(ids.get('ssh_bruteforce')).toBe('a');
  });
});
