/**
 * Centinela's own rules as specified in ARCHITECTURE §6.1, for the mocks. Session S2 writes
 * the real files in `rules/centinela/` and `rules/correlation/`; the ids here are mock ids.
 */
import type { Level, LogSource } from '@centinela/shared';

export interface CentinelaFixtureRule {
  id: string;
  name: string;
  title: string;
  description: string;
  type: 'sigma' | 'correlation';
  level: Level;
  tags: string[];
  logsource: LogSource | null;
  falsepositives: string[];
  buildingBlock: boolean;
  /** `detection:` or `correlation:` block, YAML, already indented by two spaces. */
  body: string;
}

const base = (
  rule: Omit<CentinelaFixtureRule, 'type' | 'buildingBlock'> & { buildingBlock?: boolean },
): CentinelaFixtureRule => ({ type: 'sigma', buildingBlock: false, ...rule });

const correlation = (
  rule: Omit<CentinelaFixtureRule, 'type' | 'buildingBlock' | 'logsource'>,
): CentinelaFixtureRule => ({
  type: 'correlation',
  buildingBlock: false,
  logsource: null,
  ...rule,
});

export const CENTINELA_FIXTURE_RULES: CentinelaFixtureRule[] = [
  base({
    id: '0f6a3c1e-7b1d-4c2e-9a10-5d2e3f4a5b01',
    name: 'centinela-ssh-auth-failure',
    title: 'SSH authentication failure',
    description:
      'A failed SSH login. Building block for the brute-force and spraying correlations.',
    level: 'low',
    tags: ['attack.credential-access', 'attack.t1110'],
    logsource: { product: 'linux', service: 'sshd' },
    falsepositives: ['Users mistyping their password'],
    buildingBlock: true,
    body: `detection:
  selection:
    event.action: ssh_login
    event.outcome: failure
  condition: selection`,
  }),
  base({
    id: '0f6a3c1e-7b1d-4c2e-9a10-5d2e3f4a5b02',
    name: 'centinela-ssh-auth-success',
    title: 'SSH authentication success',
    description: 'A successful SSH login. Building block for brute force followed by success.',
    level: 'informational',
    tags: ['attack.initial-access', 'attack.t1078'],
    logsource: { product: 'linux', service: 'sshd' },
    falsepositives: ['Every legitimate login'],
    buildingBlock: true,
    body: `detection:
  selection:
    event.action: ssh_login
    event.outcome: success
  condition: selection`,
  }),
  base({
    id: '0f6a3c1e-7b1d-4c2e-9a10-5d2e3f4a5b03',
    name: 'centinela-sudo-auth-failure',
    title: 'sudo authentication failure',
    description: 'A user typed a wrong password for sudo.',
    level: 'low',
    tags: ['attack.privilege-escalation', 'attack.t1548.003'],
    logsource: { product: 'linux', service: 'sudo' },
    falsepositives: ['Administrators mistyping their password'],
    body: `detection:
  selection:
    event.action: sudo_auth_failure
  condition: selection`,
  }),
  base({
    id: '0f6a3c1e-7b1d-4c2e-9a10-5d2e3f4a5b04',
    name: 'centinela-sudo-user-not-in-sudoers',
    title: 'sudo attempt by a user not in sudoers',
    description: 'A user who is not allowed to use sudo tried to run a command as another user.',
    level: 'medium',
    tags: ['attack.privilege-escalation', 'attack.t1548.003'],
    logsource: { product: 'linux', service: 'sudo' },
    falsepositives: ['New staff before their access is granted'],
    body: `detection:
  selection:
    event.action: sudo_not_in_sudoers
  condition: selection`,
  }),
  base({
    id: '0f6a3c1e-7b1d-4c2e-9a10-5d2e3f4a5b05',
    name: 'centinela-user-created',
    title: 'Local user account created',
    description: 'useradd created a new local account.',
    level: 'low',
    tags: ['attack.persistence', 'attack.t1136.001'],
    logsource: { product: 'linux', service: 'auth' },
    falsepositives: ['Provisioning of new staff or service accounts'],
    body: `detection:
  selection:
    event.action: user_created
  condition: selection`,
  }),
  base({
    id: '0f6a3c1e-7b1d-4c2e-9a10-5d2e3f4a5b06',
    name: 'centinela-user-added-to-privileged-group',
    title: 'User added to a privileged group',
    description: 'A user was added to sudo, wheel, adm or root.',
    level: 'medium',
    tags: ['attack.persistence', 'attack.t1098'],
    logsource: { product: 'linux', service: 'auth' },
    falsepositives: ['Planned promotion of an administrator'],
    body: `detection:
  selection:
    event.action: user_added_to_group
    group.name:
      - sudo
      - wheel
      - adm
      - root
  condition: selection`,
  }),
  base({
    id: '0f6a3c1e-7b1d-4c2e-9a10-5d2e3f4a5b07',
    name: 'centinela-web-not-found',
    title: 'Web request answered 404',
    description: 'A request for a missing resource. Building block for the scanning correlation.',
    level: 'informational',
    tags: ['attack.reconnaissance', 'attack.t1595.002'],
    logsource: { category: 'webserver' },
    falsepositives: ['Broken links and crawlers'],
    buildingBlock: true,
    body: `detection:
  selection:
    http.response.status_code: 404
  condition: selection`,
  }),
  correlation({
    id: '6c1f0b6e-5f5a-4e61-9a0e-1f2b3c4d5e6f',
    name: 'centinela-ssh-bruteforce',
    title: 'SSH brute force from a single source',
    description: 'Ten or more failed SSH logins from one source IP within five minutes.',
    level: 'high',
    tags: ['attack.credential-access', 'attack.t1110.001'],
    falsepositives: ['Automation retrying with an expired password'],
    body: `correlation:
  type: event_count
  rules:
    - centinela-ssh-auth-failure
  group-by:
    - source.ip
    - host.name
  timespan: 5m
  condition:
    gte: 10
  generate: false`,
  }),
  correlation({
    id: '6c1f0b6e-5f5a-4e61-9a0e-1f2b3c4d5e70',
    name: 'centinela-ssh-password-spraying',
    title: 'SSH password spraying from a single source',
    description:
      'Failed SSH logins for ten or more different users from one source within ten minutes.',
    level: 'high',
    tags: ['attack.credential-access', 'attack.t1110.003'],
    falsepositives: ['A misconfigured jump host trying many accounts'],
    body: `correlation:
  type: value_count
  rules:
    - centinela-ssh-auth-failure
  group-by:
    - source.ip
  timespan: 10m
  condition:
    gte: 10
    field: user.name
  generate: false`,
  }),
  correlation({
    id: '6c1f0b6e-5f5a-4e61-9a0e-1f2b3c4d5e71',
    name: 'centinela-ssh-bruteforce-success',
    title: 'SSH brute force followed by a successful login',
    description: 'A source that triggered the brute-force correlation then logged in successfully.',
    level: 'critical',
    tags: ['attack.credential-access', 'attack.t1110.001', 'attack.initial-access', 'attack.t1078'],
    falsepositives: ['Unlikely'],
    body: `correlation:
  type: temporal_ordered
  rules:
    - centinela-ssh-bruteforce
    - centinela-ssh-auth-success
  group-by:
    - source.ip
  timespan: 30m
  generate: false`,
  }),
  correlation({
    id: '6c1f0b6e-5f5a-4e61-9a0e-1f2b3c4d5e72',
    name: 'centinela-privileged-account-created',
    title: 'Account created and added to a privileged group',
    description:
      'A new local account joined a privileged group within ten minutes of its creation.',
    level: 'high',
    tags: ['attack.persistence', 'attack.t1136.001', 'attack.t1098'],
    falsepositives: ['Provisioning of a new administrator'],
    body: `correlation:
  type: temporal_ordered
  rules:
    - centinela-user-created
    - centinela-user-added-to-privileged-group
  group-by:
    - user.name
    - host.name
  timespan: 10m
  generate: true`,
  }),
  correlation({
    id: '6c1f0b6e-5f5a-4e61-9a0e-1f2b3c4d5e73',
    name: 'centinela-web-scanning-burst',
    title: 'Burst of 404 responses from one client',
    description:
      'Fifty or more 404 responses for one client within two minutes: content discovery.',
    level: 'medium',
    tags: ['attack.reconnaissance', 'attack.t1595.002'],
    falsepositives: ['A broken deployment referencing missing assets'],
    body: `correlation:
  type: event_count
  rules:
    - centinela-web-not-found
  group-by:
    - source.ip
    - host.name
  timespan: 2m
  condition:
    gte: 50
  generate: false`,
  }),
];

/** YAML source text of a Centinela fixture rule. */
export function centinelaRuleSource(rule: CentinelaFixtureRule): string {
  const lines = [
    `title: ${rule.title}`,
    `id: ${rule.id}`,
    `name: ${rule.name}`,
    'status: experimental',
    `description: ${rule.description}`,
    'author: DavidRamPari',
    'date: 2026-10-25',
    'tags:',
    ...rule.tags.map((tag) => `  - ${tag}`),
  ];
  if (rule.logsource) {
    lines.push('logsource:');
    for (const [key, value] of Object.entries(rule.logsource)) lines.push(`  ${key}: ${value}`);
  }
  lines.push(rule.body, 'falsepositives:', ...rule.falsepositives.map((fp) => `  - ${fp}`));
  lines.push(`level: ${rule.level}`, '');
  return lines.join('\n');
}
