/**
 * Builders for events and alert candidates used by the database and API tests. Rule
 * snapshots copy real rules from `rules/`, so alert details resolve their `RuleMeta`.
 */
import type { NormalizedEvent } from '@centinela/shared';
import { v7 as uuidv7 } from 'uuid';
import type { AlertCandidate, AlertRuleInfo } from '../../src/pipeline/types.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** ISO time `ms` before `from` (default: now). */
export function ago(ms: number, from: number = Date.now()): string {
  return new Date(from - ms).toISOString();
}

export function testEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const srcIp = overrides.srcIp ?? '203.0.113.45';
  return {
    id: uuidv7(),
    ts: ago(HOUR),
    ingestedAt: new Date().toISOString(),
    source: 'linux_auth',
    host: 'bastion-01',
    logsources: [
      { product: 'linux', service: 'sshd' },
      { product: 'linux', service: 'auth' },
    ],
    category: 'authentication',
    action: 'ssh_login',
    outcome: 'failure',
    user: 'root',
    srcIp,
    srcPort: 40000,
    message: `Failed password for root from ${srcIp} port 40000 ssh2`,
    fields: { 'process.name': 'sshd', 'event.action': 'ssh_login', 'source.ip': srcIp },
    ...overrides,
  };
}

export const RULES = {
  bruteforce: {
    id: '6c1f0b6e-5f5a-4e61-9a0e-1f2b3c4d5e6f',
    title: 'SSH brute force from a single source',
    type: 'correlation',
    level: 'high',
    techniques: ['T1110.001'],
    tactics: ['credential-access'],
    author: 'DavidRamPari',
    url: null,
    license: 'MIT',
  },
  notInSudoers: {
    id: 'b7b1255e-2d9d-4c62-ae0f-b373fd8a9212',
    title: 'User not in sudoers attempted sudo',
    type: 'sigma',
    level: 'medium',
    techniques: ['T1548.003'],
    tactics: ['privilege-escalation', 'defense-evasion'],
    author: 'DavidRamPari',
    url: null,
    license: 'MIT',
  },
  suspiciousAgent: {
    id: '19aa4f58-94ca-45ff-bc34-92e533c0994a',
    title: 'Suspicious User-Agents Related To Recon Tools',
    type: 'sigma',
    level: 'medium',
    techniques: ['T1190'],
    tactics: ['initial-access'],
    author: 'Nasreddine Bencherchali (Nextron Systems), Tim Shelton',
    url: 'https://github.com/SigmaHQ/sigma/blob/master/rules/web/webserver_generic/web_susp_useragents.yml',
    license: 'DRL-1.1',
  },
  /** A rule id that is not in `rules/` (an alert outliving its rule). */
  removed: {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Removed rule',
    type: 'sigma',
    level: 'critical',
    techniques: ['T1059.004'],
    tactics: ['execution'],
    author: null,
    url: null,
    license: 'MIT',
  },
} satisfies Record<string, AlertRuleInfo>;

export interface CandidateOptions {
  rule?: AlertRuleInfo;
  /** Defaults to `<rule id>|<host>|<first ip>`. */
  dedupKey?: string;
  firstSeen: string;
  lastSeen?: string;
  eventIds?: string[];
  host?: string | null;
  ips?: string[];
  users?: string[];
}

export function testCandidate(options: CandidateOptions): AlertCandidate {
  const rule = options.rule ?? RULES.notInSudoers;
  const host = options.host === undefined ? 'bastion-01' : options.host;
  const ips = options.ips ?? ['203.0.113.45'];
  return {
    rule,
    dedupKey: options.dedupKey ?? `${rule.id}|${host ?? ''}|${ips[0] ?? ''}`,
    groupKey: rule.type === 'correlation' ? `source.ip=${ips[0] ?? ''}` : null,
    eventIds: options.eventIds ?? [uuidv7()],
    firstSeen: options.firstSeen,
    lastSeen: options.lastSeen ?? options.firstSeen,
    host,
    entities: { ips, users: options.users ?? ['root'], hosts: host === null ? [] : [host] },
  };
}
