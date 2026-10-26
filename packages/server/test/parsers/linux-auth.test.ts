import { normalizedEventSchema, type FieldValue, type NormalizedEvent } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { parseLinuxAuth } from '../../src/parsers/linux-auth.js';
import type { IngestContext } from '../../src/pipeline/types.js';

const ctx: IngestContext = {
  source: 'linux_auth',
  host: 'fallback-host',
  receivedAt: new Date('2026-10-26T12:00:00Z'),
  timezone: 'UTC',
};

type Event = Omit<NormalizedEvent, 'id' | 'ingestedAt'>;

function parse(line: string, context: IngestContext = ctx): Event {
  const result = parseLinuxAuth(line, context);
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  // Every event must satisfy the shared contract once the pipeline adds id and ingestedAt.
  normalizedEventSchema.parse({
    ...result.event,
    id: '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f',
    ingestedAt: '2026-10-26T12:00:00.000Z',
  });
  return result.event;
}

const H = 'Oct 25 14:03:12 bastion-01';

interface Case {
  name: string;
  line: string;
  action: string;
  outcome: Event['outcome'];
  category: Event['category'];
  user?: string;
  srcIp?: string;
  srcPort?: number;
  fields?: Record<string, FieldValue>;
}

// One row per message type in ARCHITECTURE §4.1 (plus common variants).
const cases: Case[] = [
  {
    name: 'sshd accepted password',
    line: `${H} sshd[1234]: Accepted password for deploy from 203.0.113.77 port 51515 ssh2`,
    action: 'ssh_login',
    outcome: 'success',
    category: 'authentication',
    user: 'deploy',
    srcIp: '203.0.113.77',
    srcPort: 51515,
    fields: { 'ssh.method': 'password', 'ssh.invalid_user': false },
  },
  {
    name: 'sshd accepted publickey with key details',
    line: `${H} sshd[1234]: Accepted publickey for mquispe from 10.20.10.5 port 52144 ssh2: ED25519 SHA256:AbCdEf0123`,
    action: 'ssh_login',
    outcome: 'success',
    category: 'authentication',
    user: 'mquispe',
    srcIp: '10.20.10.5',
    fields: { 'ssh.method': 'publickey' },
  },
  {
    name: 'sshd accepted keyboard-interactive/pam',
    line: `${H} sshd[1234]: Accepted keyboard-interactive/pam for lrojas from 10.20.10.6 port 40000 ssh2`,
    action: 'ssh_login',
    outcome: 'success',
    category: 'authentication',
    fields: { 'ssh.method': 'keyboard-interactive/pam' },
  },
  {
    name: 'sshd accepted gssapi-with-mic',
    line: `${H} sshd[1234]: Accepted gssapi-with-mic for cflores from 10.20.10.7 port 40001 ssh2`,
    action: 'ssh_login',
    outcome: 'success',
    category: 'authentication',
    fields: { 'ssh.method': 'gssapi-with-mic' },
  },
  {
    name: 'sshd failed password for an existing user',
    line: `${H} sshd[1234]: Failed password for root from 203.0.113.45 port 40022 ssh2`,
    action: 'ssh_login',
    outcome: 'failure',
    category: 'authentication',
    user: 'root',
    srcIp: '203.0.113.45',
    srcPort: 40022,
    fields: { 'ssh.method': 'password', 'ssh.invalid_user': false },
  },
  {
    name: 'sshd failed password for an invalid user',
    line: `${H} sshd[1234]: Failed password for invalid user admin from 203.0.113.45 port 40023 ssh2`,
    action: 'ssh_login',
    outcome: 'failure',
    category: 'authentication',
    user: 'admin',
    fields: { 'ssh.invalid_user': true },
  },
  {
    name: 'sshd failed publickey',
    line: `${H} sshd[1234]: Failed publickey for git from 198.51.100.4 port 40024 ssh2`,
    action: 'ssh_login',
    outcome: 'failure',
    category: 'authentication',
    fields: { 'ssh.method': 'publickey' },
  },
  {
    name: 'sshd failed none',
    line: `${H} sshd[1234]: Failed none for invalid user test from 198.51.100.4 port 40025 ssh2`,
    action: 'ssh_login',
    outcome: 'failure',
    category: 'authentication',
    user: 'test',
    fields: { 'ssh.method': 'none', 'ssh.invalid_user': true },
  },
  {
    name: 'sshd failed keyboard-interactive/pam',
    line: `${H} sshd[1234]: Failed keyboard-interactive/pam for root from 198.51.100.4 port 40026 ssh2`,
    action: 'ssh_login',
    outcome: 'failure',
    category: 'authentication',
    fields: { 'ssh.method': 'keyboard-interactive/pam' },
  },
  {
    name: 'sshd invalid user with port',
    line: `${H} sshd[1234]: Invalid user oracle from 198.51.100.23 port 40100`,
    action: 'ssh_invalid_user',
    outcome: 'failure',
    category: 'authentication',
    user: 'oracle',
    srcIp: '198.51.100.23',
    srcPort: 40100,
    fields: { 'ssh.invalid_user': true },
  },
  {
    name: 'sshd invalid user without port (older OpenSSH)',
    line: `${H} sshd[1234]: Invalid user oracle from 198.51.100.23`,
    action: 'ssh_invalid_user',
    outcome: 'failure',
    category: 'authentication',
    srcIp: '198.51.100.23',
  },
  {
    name: 'sshd maximum authentication attempts exceeded',
    line: `${H} sshd[1234]: error: maximum authentication attempts exceeded for root from 203.0.113.45 port 40030 ssh2 [preauth]`,
    action: 'ssh_max_auth_exceeded',
    outcome: 'failure',
    category: 'authentication',
    user: 'root',
    srcIp: '203.0.113.45',
    fields: { 'ssh.invalid_user': false },
  },
  {
    name: 'sshd maximum authentication attempts exceeded for an invalid user',
    line: `${H} sshd[1234]: error: maximum authentication attempts exceeded for invalid user admin from 203.0.113.45 port 40031 ssh2 [preauth]`,
    action: 'ssh_max_auth_exceeded',
    outcome: 'failure',
    category: 'authentication',
    user: 'admin',
    fields: { 'ssh.invalid_user': true },
  },
  {
    name: 'sshd connection closed by authenticating user',
    line: `${H} sshd[1234]: Connection closed by authenticating user root 203.0.113.45 port 40032 [preauth]`,
    action: 'ssh_preauth_close',
    outcome: 'unknown',
    category: 'session',
    user: 'root',
    srcIp: '203.0.113.45',
    srcPort: 40032,
  },
  {
    name: 'sshd connection closed by invalid user',
    line: `${H} sshd[1234]: Connection closed by invalid user pi 198.51.100.23 port 40033 [preauth]`,
    action: 'ssh_preauth_close',
    outcome: 'unknown',
    category: 'session',
    user: 'pi',
    fields: { 'ssh.invalid_user': true },
  },
  {
    name: 'sshd connection closed by address',
    line: `${H} sshd[1234]: Connection closed by 198.51.100.23 port 40034 [preauth]`,
    action: 'ssh_preauth_close',
    outcome: 'unknown',
    category: 'session',
    srcIp: '198.51.100.23',
  },
  {
    name: 'sshd connection reset by address',
    line: `${H} sshd[1234]: Connection reset by 198.51.100.23 port 40035`,
    action: 'ssh_preauth_close',
    outcome: 'unknown',
    category: 'session',
    srcPort: 40035,
  },
  {
    name: 'sshd received disconnect',
    line: `${H} sshd[1234]: Received disconnect from 10.20.10.5 port 52144:11: disconnected by user`,
    action: 'ssh_disconnect',
    outcome: 'unknown',
    category: 'session',
    srcIp: '10.20.10.5',
    srcPort: 52144,
  },
  {
    name: 'sshd disconnected from user',
    line: `${H} sshd[1234]: Disconnected from user mquispe 10.20.10.5 port 52144`,
    action: 'ssh_disconnect',
    outcome: 'unknown',
    category: 'session',
    user: 'mquispe',
    srcIp: '10.20.10.5',
  },
  {
    name: 'sshd disconnected from address',
    line: `${H} sshd[1234]: Disconnected from 203.0.113.45 port 40036 [preauth]`,
    action: 'ssh_disconnect',
    outcome: 'unknown',
    category: 'session',
    srcIp: '203.0.113.45',
  },
  {
    name: 'sshd PAM authentication failure with user',
    line: `${H} sshd[1234]: pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.45  user=root`,
    action: 'ssh_pam_auth_failure',
    outcome: 'failure',
    category: 'authentication',
    user: 'root',
    srcIp: '203.0.113.45',
  },
  {
    name: 'sshd PAM authentication failure without user',
    line: `${H} sshd[1234]: pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.45`,
    action: 'ssh_pam_auth_failure',
    outcome: 'failure',
    category: 'authentication',
    srcIp: '203.0.113.45',
  },
  {
    name: 'PAM session opened with uid',
    line: `${H} sshd[1234]: pam_unix(sshd:session): session opened for user deploy(uid=1001) by (uid=0)`,
    action: 'session_opened',
    outcome: 'success',
    category: 'session',
    user: 'deploy',
    fields: { 'session.service': 'sshd', 'user.id': '1001' },
  },
  {
    name: 'PAM session opened without uid (cron)',
    line: `${H} CRON[777]: pam_unix(cron:session): session opened for user root by (uid=0)`,
    action: 'session_opened',
    outcome: 'success',
    category: 'session',
    user: 'root',
    fields: { 'session.service': 'cron', 'process.name': 'CRON', 'process.pid': 777 },
  },
  {
    name: 'PAM session closed',
    line: `${H} sudo[999]: pam_unix(sudo:session): session closed for user root`,
    action: 'session_closed',
    outcome: 'success',
    category: 'session',
    user: 'root',
    fields: { 'session.service': 'sudo' },
  },
  {
    name: 'sudo command',
    line: `${H} sudo:   deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/apt update`,
    action: 'sudo_command',
    outcome: 'success',
    category: 'process',
    user: 'deploy',
    fields: {
      'sudo.command': '/usr/bin/apt update',
      'sudo.target_user': 'root',
      'sudo.tty': 'pts/0',
      'sudo.pwd': '/home/deploy',
    },
  },
  {
    name: 'sudo command containing " ; " and sudo 1.9 extra keys',
    line: `${H} sudo[42]: deploy : TTY=pts/1 ; PWD=/tmp ; USER=root ; ENV=LANG=C ; COMMAND=/usr/bin/sh -c cd /tmp ; ls`,
    action: 'sudo_command',
    outcome: 'success',
    category: 'process',
    fields: { 'sudo.command': '/usr/bin/sh -c cd /tmp ; ls', 'sudo.pwd': '/tmp' },
  },
  {
    name: 'sudo incorrect password attempts',
    line: `${H} sudo[42]:   intern : 3 incorrect password attempts ; TTY=pts/1 ; PWD=/home/intern ; USER=root ; COMMAND=/usr/bin/id`,
    action: 'sudo_auth_failure',
    outcome: 'failure',
    category: 'authentication',
    user: 'intern',
    fields: { 'sudo.failed_attempts': 3, 'sudo.command': '/usr/bin/id' },
  },
  {
    name: 'sudo one incorrect password attempt',
    line: `${H} sudo[42]:   intern : 1 incorrect password attempt ; TTY=pts/1 ; PWD=/home/intern ; USER=root ; COMMAND=/usr/bin/id`,
    action: 'sudo_auth_failure',
    outcome: 'failure',
    category: 'authentication',
    fields: { 'sudo.failed_attempts': 1 },
  },
  {
    name: 'sudo PAM authentication failure',
    line: `${H} sudo[42]: pam_unix(sudo:auth): authentication failure; logname=intern uid=1007 euid=0 tty=/dev/pts/1 ruser=intern rhost=  user=intern`,
    action: 'sudo_auth_failure',
    outcome: 'failure',
    category: 'authentication',
    user: 'intern',
  },
  {
    name: 'sudo user NOT in sudoers',
    line: `${H} sudo[42]:   intern : user NOT in sudoers ; TTY=pts/1 ; PWD=/home/intern ; USER=root ; COMMAND=/usr/bin/cat /etc/shadow`,
    action: 'sudo_not_in_sudoers',
    outcome: 'failure',
    category: 'iam',
    user: 'intern',
    fields: { 'sudo.command': '/usr/bin/cat /etc/shadow', 'sudo.target_user': 'root' },
  },
  {
    name: 'useradd new user',
    line: `${H} useradd[5150]: new user: name=backup2, UID=1005, GID=27, home=/home/backup2, shell=/bin/bash, from=/dev/pts/3`,
    action: 'user_created',
    outcome: 'success',
    category: 'iam',
    user: 'backup2',
    fields: { 'user.id': '1005', 'group.id': '27', 'user.shell': '/bin/bash' },
  },
  {
    name: 'useradd new user without from= (older shadow-utils)',
    line: `${H} useradd[5150]: new user: name=svc, UID=998, GID=998, home=/nonexistent, shell=/usr/sbin/nologin`,
    action: 'user_created',
    outcome: 'success',
    category: 'iam',
    user: 'svc',
  },
  {
    name: 'groupadd new group',
    line: `${H} groupadd[5151]: new group: name=analysts, GID=1010`,
    action: 'group_created',
    outcome: 'success',
    category: 'iam',
    fields: { 'group.name': 'analysts', 'group.id': '1010' },
  },
  {
    name: 'usermod add to group',
    line: `${H} usermod[5152]: add 'backup2' to group 'sudo'`,
    action: 'user_added_to_group',
    outcome: 'success',
    category: 'iam',
    user: 'backup2',
    fields: { 'group.name': 'sudo', 'group.shadow': false },
  },
  {
    name: 'usermod add to shadow group',
    line: `${H} usermod[5152]: add 'backup2' to shadow group 'sudo'`,
    action: 'user_added_to_group',
    outcome: 'success',
    category: 'iam',
    fields: { 'group.name': 'sudo', 'group.shadow': true },
  },
  {
    name: 'gpasswd user added to group',
    line: `${H} gpasswd[5153]: user backup2 added by root to group wheel`,
    action: 'user_added_to_group',
    outcome: 'success',
    category: 'iam',
    user: 'backup2',
    fields: { 'group.name': 'wheel' },
  },
  {
    name: 'passwd password changed',
    line: `${H} passwd[5154]: pam_unix(passwd:chauthtok): password changed for backup2`,
    action: 'password_changed',
    outcome: 'success',
    category: 'iam',
    user: 'backup2',
  },
  {
    name: 'su session (to R) U on tty',
    line: `${H} su[6000]: (to root) mquispe on pts/2`,
    action: 'su_session',
    outcome: 'success',
    category: 'authentication',
    user: 'mquispe',
    fields: { 'user.target.name': 'root' },
  },
  {
    name: 'su successful su for R by U',
    line: `${H} su[6000]: Successful su for postgres by root`,
    action: 'su_session',
    outcome: 'success',
    category: 'authentication',
    user: 'root',
    fields: { 'user.target.name': 'postgres' },
  },
  {
    name: 'su FAILED SU',
    line: `${H} su[6001]: FAILED SU (to root) intern on pts/1`,
    action: 'su_failure',
    outcome: 'failure',
    category: 'authentication',
    user: 'intern',
    fields: { 'user.target.name': 'root' },
  },
  {
    name: 'su pam_authenticate failure',
    line: `${H} su[6001]: pam_authenticate: Authentication failure`,
    action: 'su_failure',
    outcome: 'failure',
    category: 'authentication',
  },
  {
    name: 'su PAM authentication failure',
    line: `${H} su[6001]: pam_unix(su:auth): authentication failure; logname=intern uid=1007 euid=0 tty=pts/1 ruser=intern rhost=  user=root`,
    action: 'su_failure',
    outcome: 'failure',
    category: 'authentication',
    user: 'intern',
    fields: { 'user.target.name': 'root' },
  },
  {
    name: 'systemd-logind new session',
    line: `${H} systemd-logind[812]: New session 2041 of user deploy.`,
    action: 'logind_session_new',
    outcome: 'success',
    category: 'session',
    user: 'deploy',
    fields: { 'session.id': '2041' },
  },
  {
    name: 'systemd-logind removed session',
    line: `${H} systemd-logind[812]: Removed session 2041.`,
    action: 'logind_session_removed',
    outcome: 'success',
    category: 'session',
    fields: { 'session.id': '2041' },
  },
  {
    name: 'unknown sshd message',
    line: `${H} sshd[900]: Server listening on 0.0.0.0 port 22.`,
    action: 'other',
    outcome: 'unknown',
    category: 'other',
  },
  {
    name: 'unknown program',
    line: `${H} kernel: [ 1234.567] audit: type=1400 apparmor="DENIED"`,
    action: 'other',
    outcome: 'unknown',
    category: 'other',
    fields: { 'process.name': 'kernel' },
  },
  {
    name: 'cron CMD line',
    line: `${H} CRON[778]: (root) CMD (cd / && run-parts --report /etc/cron.hourly)`,
    action: 'other',
    outcome: 'unknown',
    category: 'other',
  },
];

describe('linux_auth parser: message types', () => {
  it.each(cases)('$name', (c) => {
    const event = parse(c.line);
    expect(event.action).toBe(c.action);
    expect(event.outcome).toBe(c.outcome);
    expect(event.category).toBe(c.category);
    expect(event.fields['event.action']).toBe(c.action);
    expect(event.fields['event.outcome']).toBe(c.outcome);
    expect(event.fields['event.category']).toBe(c.category);
    if (c.user !== undefined) {
      expect(event.user).toBe(c.user);
      expect(event.fields['user.name']).toBe(c.user);
    }
    if (c.srcIp !== undefined) {
      expect(event.srcIp).toBe(c.srcIp);
      expect(event.fields['source.ip']).toBe(c.srcIp);
    }
    if (c.srcPort !== undefined) {
      expect(event.srcPort).toBe(c.srcPort);
      expect(event.fields['source.port']).toBe(c.srcPort);
    }
    expect(event.fields).toMatchObject(c.fields ?? {});
    expect(event.message).toBe(c.line);
    expect(event.source).toBe('linux_auth');
  });
});

describe('linux_auth parser: header, timestamps and logsources', () => {
  it('reads host, program and pid from the line', () => {
    const event = parse(`${H} sshd[1234]: Accepted password for a from 10.0.0.1 port 1 ssh2`);
    expect(event.host).toBe('bastion-01');
    expect(event.fields).toMatchObject({
      'host.name': 'bastion-01',
      'process.name': 'sshd',
      'process.pid': 1234,
    });
  });

  it('accepts a tag without pid', () => {
    const event = parse(
      'Oct 25 14:03:12 bastion-01 sudo:   deploy : TTY=pts/0 ; PWD=/ ; USER=root ; COMMAND=/bin/ls',
    );
    expect(event.fields['process.name']).toBe('sudo');
    expect(event.fields['process.pid']).toBeUndefined();
  });

  it('routes sshd, sudo and other programs to their Sigma logsources', () => {
    const sshd = parse(`${H} sshd[1]: Server listening on :: port 22.`);
    const sshdSession = parse(
      `${H} sshd-session[2]: Failed password for root from 10.0.0.1 port 1 ssh2`,
    );
    const sudo = parse(`${H} sudo[3]: pam_unix(sudo:session): session closed for user root`);
    const cron = parse(`${H} CRON[4]: pam_unix(cron:session): session closed for user root`);
    expect(sshd.logsources).toEqual([
      { product: 'linux', service: 'sshd' },
      { product: 'linux', service: 'auth' },
    ]);
    expect(sshdSession.logsources[0]).toEqual({ product: 'linux', service: 'sshd' });
    expect(sshdSession.action).toBe('ssh_login');
    expect(sudo.logsources).toEqual([
      { product: 'linux', service: 'sudo' },
      { product: 'linux', service: 'auth' },
    ]);
    expect(cron.logsources).toEqual([{ product: 'linux', service: 'auth' }]);
  });

  it('reads RFC 3164 timestamps in the ingest time zone', () => {
    const utc = parse(`${H} sshd[1]: x`);
    expect(utc.ts).toBe('2026-10-25T14:03:12.000Z');
    const lima = parse(`${H} sshd[1]: x`, { ...ctx, timezone: 'America/Lima' });
    expect(lima.ts).toBe('2026-10-25T19:03:12.000Z');
  });

  it('accepts single-digit days padded with a space', () => {
    expect(parse('Oct  5 01:02:03 h sshd[1]: x').ts).toBe('2026-10-05T01:02:03.000Z');
  });

  it('uses defaultYear for RFC 3164 timestamps when given', () => {
    expect(parse(`${H} sshd[1]: x`, { ...ctx, defaultYear: 2024 }).ts).toBe(
      '2024-10-25T14:03:12.000Z',
    );
  });

  it('moves RFC 3164 dates more than 24 h in the future one year back (year rollover)', () => {
    const january = { ...ctx, receivedAt: new Date('2027-01-02T08:00:00Z') };
    expect(parse('Dec 31 23:59:58 h sshd[1]: x', january).ts).toBe('2026-12-31T23:59:58.000Z');
    expect(parse('Jan  2 07:00:00 h sshd[1]: x', january).ts).toBe('2027-01-02T07:00:00.000Z');
    // Up to 24 hours ahead is clock skew, not last year.
    expect(parse('Jan  2 20:00:00 h sshd[1]: x', january).ts).toBe('2027-01-02T20:00:00.000Z');
  });

  it('reads RFC 3339 timestamps with microseconds and an offset', () => {
    const event = parse(
      '2026-10-25T14:03:12.123456-05:00 bastion-01 sshd[1234]: Failed password for root from 203.0.113.45 port 4 ssh2',
    );
    expect(event.ts).toBe('2026-10-25T19:03:12.123Z');
    expect(event.host).toBe('bastion-01');
    expect(event.action).toBe('ssh_login');
  });

  it('reads RFC 3339 timestamps with Z and without a fraction', () => {
    expect(parse('2026-10-25T14:03:12Z h sshd[1]: x').ts).toBe('2026-10-25T14:03:12.000Z');
  });

  it('reads RFC 3339 timestamps without an offset in the ingest time zone', () => {
    const event = parse('2026-10-25T14:03:12 h sshd[1]: x', { ...ctx, timezone: 'America/Lima' });
    expect(event.ts).toBe('2026-10-25T19:03:12.000Z');
  });

  it('normalizes IPv6 and IPv4-mapped addresses', () => {
    const v6 = parse(
      `${H} sshd[1]: Failed password for root from 2001:DB8:0:0:0:0:0:1 port 22 ssh2`,
    );
    expect(v6.srcIp).toBe('2001:db8::1');
    expect(v6.fields['source.address']).toBe('2001:DB8:0:0:0:0:0:1');
    const mapped = parse(
      `${H} sshd[1]: Accepted password for a from ::ffff:203.0.113.9 port 22 ssh2`,
    );
    expect(mapped.srcIp).toBe('203.0.113.9');
    const zoned = parse(`${H} sshd[1]: Connection closed by fe80::1%eth0 port 22 [preauth]`);
    expect(zoned.srcIp).toBe('fe80::1');
  });

  it('keeps a host name in rhost= as source.address without source.ip', () => {
    const event = parse(
      `${H} sshd[1]: pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=scanner.example  user=root`,
    );
    expect(event.srcIp).toBeUndefined();
    expect(event.fields['source.ip']).toBeUndefined();
    expect(event.fields['source.address']).toBe('scanner.example');
  });

  it('takes the last " from IP port P" when an attacker puts one in the user name', () => {
    const event = parse(
      `${H} sshd[1]: Failed password for invalid user x from 10.0.0.1 port 1 from 203.0.113.45 port 40000 ssh2`,
    );
    expect(event.srcIp).toBe('203.0.113.45');
    expect(event.srcPort).toBe(40000);
    expect(event.user).toBe('x from 10.0.0.1 port 1');
  });

  it('unfolds rsyslog "message repeated" lines', () => {
    const event = parse(
      `${H} sshd[1]: message repeated 5 times: [ Failed password for root from 203.0.113.45 port 40000 ssh2]`,
    );
    expect(event.action).toBe('ssh_login');
    expect(event.outcome).toBe('failure');
    expect(event.fields['syslog.repeat_count']).toBe(5);
  });
});

describe('linux_auth parser: malformed and hostile input', () => {
  it.each([
    ['an empty line', ''],
    ['free text', 'hello world'],
    ['a JSON object', '{"msg":"Oct 25 14:03:12 h sshd[1]: x"}'],
    ['a timestamp without host and message', 'Oct 25 14:03:12'],
  ])('rejects %s as not a syslog line', (_name, line) => {
    expect(parseLinuxAuth(line, ctx)).toEqual({ ok: false, reason: 'not a syslog line' });
  });

  it.each([
    ['an unknown month', 'Foo 25 14:03:12 h sshd[1]: x'],
    ['an impossible RFC 3164 date', 'Feb 30 10:00:00 h sshd[1]: x'],
    ['an impossible RFC 3164 time', 'Oct 25 25:61:00 h sshd[1]: x'],
    ['an impossible RFC 3339 date', '2026-13-01T00:00:00Z h sshd[1]: x'],
    ['an out-of-range offset', '2026-10-25T00:00:00+25:00 h sshd[1]: x'],
  ])('rejects %s as an invalid timestamp', (_name, line) => {
    expect(parseLinuxAuth(line, ctx)).toEqual({ ok: false, reason: 'invalid timestamp' });
  });

  it('truncates very long lines to 8,192 characters', () => {
    const long = `${H} sshd[1]: Invalid user ${'a'.repeat(20_000)} from 203.0.113.45 port 4`;
    const event = parse(long);
    expect(event.message).toHaveLength(8192);
    expect(event.message).toBe(long.slice(0, 8192));
    expect(
      typeof event.fields['user.name'] === 'string' && event.fields['user.name'].length,
    ).toBeLessThanOrEqual(8192);
  });

  it('parses a huge line in bounded time', () => {
    const huge = `${H} sshd[1]: Failed password for ${' from x port 1'.repeat(200_000)}`;
    const started = performance.now();
    const result = parseLinuxAuth(huge, ctx);
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.ok).toBe(true);
  });

  it('replaces NUL characters and lone surrogates so PostgreSQL accepts the text', () => {
    const event = parse(`${H} sshd[1]: Invalid user a\u0000b\uD800 from 203.0.113.45 port 4`);
    expect(event.message).not.toContain('\u0000');
    expect(event.user).toBe('a\uFFFDb\uFFFD');
  });

  it('never throws on random bytes', () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 2000; i += 1) {
      const length = Math.floor(random() * 200);
      const line = Array.from({ length }, () =>
        String.fromCharCode(Math.floor(random() * 0xffff)),
      ).join('');
      expect(() => parseLinuxAuth(`${H} ${line}`, ctx)).not.toThrow();
      expect(() => parseLinuxAuth(line, ctx)).not.toThrow();
    }
  });
});
