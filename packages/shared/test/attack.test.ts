import { describe, expect, it } from 'vitest';
import { createAttackIndex, techniquesFromTags } from '../src/index.js';
import { defaultAttackDataPath, loadAttackIndex, loadAttackIndexSync } from '../src/node.js';

const attack = loadAttackIndexSync();

describe('techniquesFromTags', () => {
  it('extracts upper-cased technique ids and ignores other tags', () => {
    expect(
      techniquesFromTags([
        'attack.credential-access',
        'attack.t1110.001',
        'attack.T1078',
        'attack.g0016',
        'attack.s0002',
        'cve.2021-44228',
        'attack.t1110.001',
      ]),
    ).toEqual(['T1110.001', 'T1078']);
  });
});

describe('ATT&CK index (data/mitre-attack)', () => {
  it('loads the repository data file', async () => {
    expect(defaultAttackDataPath).toMatch(
      /data[\\/]mitre-attack[\\/]enterprise-attack\.min\.json$/,
    );
    const index = await loadAttackIndex();
    expect(index.tactics.length).toBe(15);
    expect(index.techniques.length).toBeGreaterThan(600);
  });

  it('maps a sub-technique to its name, tactics and URL', () => {
    expect(attack.technique('t1110.001')).toEqual({
      id: 'T1110.001',
      name: 'Password Guessing',
      tactics: ['credential-access'],
      url: 'https://attack.mitre.org/techniques/T1110/001',
    });
  });

  it('falls back to the parent technique for an unknown sub-technique', () => {
    const info = attack.technique('T1110.999');
    expect(info?.id).toBe('T1110.999');
    expect(info?.tactics).toEqual(['credential-access']);
    expect(info?.url).toBe('https://attack.mitre.org/techniques/T1110');
  });

  it('returns undefined for unknown techniques', () => {
    expect(attack.technique('T9999')).toBeUndefined();
    expect(attack.technique('credential-access')).toBeUndefined();
  });

  it('derives tactics from techniques in matrix order, de-duplicated', () => {
    // T1078 (Valid Accounts) spans several tactics; T1110.001 adds credential-access.
    const tactics = attack.tacticsFor(['T1110.001', 'T1078', 'T1110.003']);
    expect(tactics).toContain('credential-access');
    expect(tactics).toContain('initial-access');
    expect(new Set(tactics).size).toBe(tactics.length);
    const order = attack.tactics.map((t) => t.shortname);
    const positions = tactics.map((t) => order.indexOf(t));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('looks tactics up by shortname', () => {
    expect(attack.tactic('credential-access')?.id).toBe('TA0006');
    expect(attack.tactic('defense-evasion')).toBeUndefined();
  });

  it('rejects malformed data', () => {
    expect(() => createAttackIndex({ tactics: [], techniques: [] })).toThrow();
    expect(() => createAttackIndex('not json data')).toThrow();
  });
});
