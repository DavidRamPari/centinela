import { describe, expect, it } from 'vitest';
import { allowsHost, allowsSource, hostMatches } from '../../src/ingest/scope.js';

describe('token scope', () => {
  it('allows everything with empty lists', () => {
    const open = { sources: [], hosts: [] };
    expect(allowsSource(open, 'sysmon')).toBe(true);
    expect(allowsHost(open, 'anything at all')).toBe(true);
  });

  it.each([
    ['web-01', 'web-01', true],
    ['web-01', 'WEB-01', true],
    ['web-01', 'web-011', false],
    ['web-*', 'web-', true],
    ['web-*', 'Web-42.example.com', true],
    ['web-*', 'db-web-01', false],
    ['*', 'anything', true],
    ['a.b*', 'aXb', false],
    ['a.b*', 'a.b.c', true],
    // Only A to Z fold: U+0130 lower-cases to "i" plus a dot outside ASCII.
    ['i*', 'İnfra', false],
    ['k*', 'Key', false],
    // Pattern characters in a host are plain text.
    ['web-01', 'web-0.', false],
    ['web-01', '(web-01)', false],
  ])('%s against %s: %s', (pattern, host, expected) => {
    expect(hostMatches(pattern, host)).toBe(expected);
  });

  it('allows a host when one of the patterns matches, and a source when it is listed', () => {
    const scope = { sources: ['linux_auth'], hosts: ['web-01', 'db-*'] };
    expect(allowsHost(scope, 'DB-02')).toBe(true);
    expect(allowsHost(scope, 'web-02')).toBe(false);
    expect(allowsSource(scope, 'linux_auth')).toBe(true);
    expect(allowsSource(scope, 'nginx_access')).toBe(false);
  });

  it('compares a long hostile host in linear time', () => {
    const host = `${'a'.repeat(50_000)}!`;
    const started = performance.now();
    for (let i = 0; i < 100; i += 1) hostMatches(`${'a'.repeat(40_000)}*`, host);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
