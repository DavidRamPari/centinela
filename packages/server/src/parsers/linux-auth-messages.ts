/**
 * Message classifiers for Linux auth.log (ARCHITECTURE §4.1). Each matcher recognizes one
 * message shape of one program family and maps it to action, outcome, category, user,
 * source address and extra fields. The first matcher that applies wins; messages nobody
 * recognizes become `action: "other"` in `linux-auth.ts`.
 *
 * Every pattern is anchored and avoids nested quantifiers, so matching stays linear in
 * the line length. User names logged by sshd are attacker-chosen and may contain spaces
 * or text such as " from 1.2.3.4 port 1"; the greedy `(.*)` before ` from` makes the
 * last occurrence win, which is the one sshd itself appended.
 */
import type { EventCategory, FieldValue, Outcome } from '@centinela/shared';
import { normalizeIp, parseCount, parsePort } from './common.js';

export interface Classified {
  action: string;
  outcome: Outcome;
  category: EventCategory;
  user?: string | undefined;
  srcIp?: string | undefined;
  srcPort?: number | undefined;
  fields?: Record<string, FieldValue | undefined>;
}

interface Matcher {
  /** Lower-cased program names this matcher applies to; undefined means any program. */
  programs?: ReadonlySet<string>;
  pattern: RegExp;
  classify(m: RegExpExecArray): Classified;
}

export const SSHD_PROGRAMS: ReadonlySet<string> = new Set(['sshd', 'sshd-session', 'sshd-auth']);
const SUDO_PROGRAMS: ReadonlySet<string> = new Set(['sudo']);
const USERADD_PROGRAMS: ReadonlySet<string> = new Set(['useradd']);
const GROUPADD_PROGRAMS: ReadonlySet<string> = new Set(['useradd', 'groupadd']);
const GROUP_MEMBER_PROGRAMS: ReadonlySet<string> = new Set(['useradd', 'usermod', 'gpasswd']);
const SU_PROGRAMS: ReadonlySet<string> = new Set(['su']);
const LOGIND_PROGRAMS: ReadonlySet<string> = new Set(['systemd-logind']);

/** `source.ip`/`source.port` plus the raw `source.address` (may be a host name). */
function remote(address: string | undefined, port?: string) {
  if (address === undefined) return {};
  return {
    srcIp: normalizeIp(address),
    srcPort: parsePort(port),
    address,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** `logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.45  user=root` → key/value map. */
export function parsePamPairs(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const token of text.split(' ')) {
    const eq = token.indexOf('=');
    if (eq > 0) pairs.set(token.slice(0, eq), token.slice(eq + 1));
  }
  return pairs;
}

function sshLogin(
  outcome: Outcome,
  method: string | undefined,
  invalidUser: boolean,
  user: string | undefined,
  address: string | undefined,
  port: string | undefined,
): Classified {
  const r = remote(address, port);
  return {
    action: 'ssh_login',
    outcome,
    category: 'authentication',
    user: nonEmpty(user),
    srcIp: r.srcIp,
    srcPort: r.srcPort,
    fields: { 'ssh.method': method, 'ssh.invalid_user': invalidUser, 'source.address': r.address },
  };
}

function sshEvent(
  action: string,
  outcome: Outcome,
  category: EventCategory,
  user: string | undefined,
  address: string | undefined,
  port: string | undefined,
  fields: Record<string, FieldValue | undefined> = {},
): Classified {
  const r = remote(address, port);
  return {
    action,
    outcome,
    category,
    user: nonEmpty(user),
    srcIp: r.srcIp,
    srcPort: r.srcPort,
    fields: { ...fields, 'source.address': r.address },
  };
}

/**
 * sudo's own lines: `U : [N incorrect password attempts ; | user NOT in sudoers ; ]
 * TTY=T ; PWD=D ; USER=R ; [GROUP=G ; ENV=... ;] COMMAND=C`. COMMAND is always last and may
 * itself contain " ; ", so it takes the rest of the line.
 */
const SUDO_LINE =
  /^(\S+) : (?:(\d+) incorrect password attempts? ; |(user NOT in sudoers) ; )?(TTY=.*)$/;

export function classifySudoLine(message: string): Classified | undefined {
  const m = SUDO_LINE.exec(message);
  if (!m) return undefined;
  const [, user, attempts, notInSudoers, rest = ''] = m;
  const values = new Map<string, string>();
  let remaining = rest;
  for (;;) {
    if (remaining.startsWith('COMMAND=')) {
      values.set('COMMAND', remaining.slice('COMMAND='.length));
      break;
    }
    const eq = remaining.indexOf('=');
    const end = remaining.indexOf(' ; ');
    if (eq <= 0 || end === -1 || eq > end) break;
    values.set(remaining.slice(0, eq), remaining.slice(eq + 1, end));
    remaining = remaining.slice(end + 3);
  }
  const command = values.get('COMMAND');
  if (command === undefined) return undefined;
  const fields = {
    'sudo.command': command,
    'sudo.target_user': values.get('USER'),
    'sudo.tty': values.get('TTY'),
    'sudo.pwd': values.get('PWD'),
    'sudo.failed_attempts': parseCount(attempts),
  };
  if (notInSudoers !== undefined) {
    return { action: 'sudo_not_in_sudoers', outcome: 'failure', category: 'iam', user, fields };
  }
  if (attempts !== undefined) {
    return {
      action: 'sudo_auth_failure',
      outcome: 'failure',
      category: 'authentication',
      user,
      fields,
    };
  }
  return { action: 'sudo_command', outcome: 'success', category: 'process', user, fields };
}

const MATCHERS: readonly Matcher[] = [
  // --- sshd ---------------------------------------------------------------------------
  {
    programs: SSHD_PROGRAMS,
    pattern: /^Accepted (\S+) for (.*) from (\S+) port (\d+)(?: ssh2(?:: .*)?)?$/,
    classify: (m) => sshLogin('success', m[1], false, m[2], m[3], m[4]),
  },
  {
    programs: SSHD_PROGRAMS,
    pattern: /^Failed (\S+) for (invalid user )?(.*) from (\S+) port (\d+)(?: ssh2)?$/,
    classify: (m) => sshLogin('failure', m[1], m[2] !== undefined, m[3], m[4], m[5]),
  },
  {
    programs: SSHD_PROGRAMS,
    pattern: /^Invalid user (.*) from (\S+)(?: port (\d+))?$/,
    classify: (m) =>
      sshEvent('ssh_invalid_user', 'failure', 'authentication', m[1], m[2], m[3], {
        'ssh.invalid_user': true,
      }),
  },
  {
    programs: SSHD_PROGRAMS,
    pattern:
      /^(?:error: )?maximum authentication attempts exceeded for (invalid user )?(.*) from (\S+) port (\d+)(?: ssh2)?(?: \[preauth\])?$/,
    classify: (m) =>
      sshEvent('ssh_max_auth_exceeded', 'failure', 'authentication', m[2], m[3], m[4], {
        'ssh.invalid_user': m[1] !== undefined,
      }),
  },
  {
    programs: SSHD_PROGRAMS,
    pattern:
      /^Connection closed by (authenticating|invalid) user (.*) (\S+) port (\d+)(?: \[preauth\])?$/,
    classify: (m) =>
      sshEvent('ssh_preauth_close', 'unknown', 'session', m[2], m[3], m[4], {
        'ssh.invalid_user': m[1] === 'invalid',
      }),
  },
  {
    programs: SSHD_PROGRAMS,
    pattern: /^Connection (?:closed|reset) by (\S+) port (\d+)(?: \[preauth\])?$/,
    classify: (m) => sshEvent('ssh_preauth_close', 'unknown', 'session', undefined, m[1], m[2]),
  },
  {
    programs: SSHD_PROGRAMS,
    pattern: /^Received disconnect from (\S+) port (\d+):.*$/,
    classify: (m) => sshEvent('ssh_disconnect', 'unknown', 'session', undefined, m[1], m[2]),
  },
  {
    programs: SSHD_PROGRAMS,
    pattern:
      /^Disconnected from (?:(?:authenticating |invalid )?user (.*) )?(\S+) port (\d+)(?: \[preauth\])?$/,
    classify: (m) => sshEvent('ssh_disconnect', 'unknown', 'session', m[1], m[2], m[3]),
  },
  {
    programs: SSHD_PROGRAMS,
    pattern: /^pam_unix\(sshd:auth\): authentication failure; (.*)$/,
    classify: (m) => {
      const pairs = parsePamPairs(m[1] ?? '');
      return sshEvent(
        'ssh_pam_auth_failure',
        'failure',
        'authentication',
        pairs.get('user'),
        nonEmpty(pairs.get('rhost')),
        undefined,
      );
    },
  },

  // --- sudo -----------------------------------------------------------------------------
  {
    programs: SUDO_PROGRAMS,
    pattern: /^pam_unix\(sudo(?:-i)?:auth\): authentication failure; (.*)$/,
    classify: (m) => {
      const pairs = parsePamPairs(m[1] ?? '');
      return {
        action: 'sudo_auth_failure',
        outcome: 'failure',
        category: 'authentication',
        user: nonEmpty(pairs.get('user')) ?? nonEmpty(pairs.get('ruser')),
      };
    },
  },

  // --- account management ---------------------------------------------------------------
  {
    programs: USERADD_PROGRAMS,
    pattern:
      /^new user: name=([^,]+), UID=(\d+), GID=(\d+), home=([^,]*), shell=([^,]*)(?:, from=.*)?$/,
    classify: (m) => ({
      action: 'user_created',
      outcome: 'success',
      category: 'iam',
      user: m[1],
      fields: {
        'user.id': m[2],
        'group.id': m[3],
        'user.home': m[4],
        'user.shell': m[5],
      },
    }),
  },
  {
    programs: GROUPADD_PROGRAMS,
    pattern: /^new group: name=([^,]+), GID=(\d+)$/,
    classify: (m) => ({
      action: 'group_created',
      outcome: 'success',
      category: 'iam',
      fields: { 'group.name': m[1], 'group.id': m[2] },
    }),
  },
  {
    programs: GROUP_MEMBER_PROGRAMS,
    pattern: /^add '([^']+)' to (shadow )?group '([^']+)'$/,
    classify: (m) => ({
      action: 'user_added_to_group',
      outcome: 'success',
      category: 'iam',
      user: m[1],
      fields: { 'group.name': m[3], 'group.shadow': m[2] !== undefined },
    }),
  },
  {
    programs: GROUP_MEMBER_PROGRAMS,
    pattern: /^user (\S+) added by (\S+) to group (\S+)$/,
    classify: (m) => ({
      action: 'user_added_to_group',
      outcome: 'success',
      category: 'iam',
      user: m[1],
      fields: { 'group.name': m[3], 'user.changes.by': m[2] },
    }),
  },
  {
    pattern: /^pam_unix\(passwd:chauthtok\): password changed for (\S+)$/,
    classify: (m) => ({
      action: 'password_changed',
      outcome: 'success',
      category: 'iam',
      user: m[1],
    }),
  },

  // --- su -------------------------------------------------------------------------------
  {
    programs: SU_PROGRAMS,
    pattern: /^\(to (\S+)\) (\S+) on (\S+)$/,
    classify: (m) => ({
      action: 'su_session',
      outcome: 'success',
      category: 'authentication',
      user: m[2],
      fields: { 'user.target.name': m[1], 'process.tty': m[3] },
    }),
  },
  {
    programs: SU_PROGRAMS,
    pattern: /^Successful su for (\S+) by (\S+)$/,
    classify: (m) => ({
      action: 'su_session',
      outcome: 'success',
      category: 'authentication',
      user: m[2],
      fields: { 'user.target.name': m[1] },
    }),
  },
  {
    programs: SU_PROGRAMS,
    pattern: /^FAILED SU \(to (\S+)\) (\S+) on (\S+)$/,
    classify: (m) => ({
      action: 'su_failure',
      outcome: 'failure',
      category: 'authentication',
      user: m[2],
      fields: { 'user.target.name': m[1], 'process.tty': m[3] },
    }),
  },
  {
    programs: SU_PROGRAMS,
    pattern: /^pam_authenticate: Authentication failure$/,
    classify: () => ({ action: 'su_failure', outcome: 'failure', category: 'authentication' }),
  },
  {
    programs: SU_PROGRAMS,
    pattern: /^pam_unix\(su(?:-l)?:auth\): authentication failure; (.*)$/,
    classify: (m) => {
      const pairs = parsePamPairs(m[1] ?? '');
      return {
        action: 'su_failure',
        outcome: 'failure',
        category: 'authentication',
        user: nonEmpty(pairs.get('ruser')) ?? nonEmpty(pairs.get('logname')),
        fields: { 'user.target.name': nonEmpty(pairs.get('user')) },
      };
    },
  },

  // --- systemd-logind -------------------------------------------------------------------
  {
    programs: LOGIND_PROGRAMS,
    pattern: /^New session (\S+) of user (\S+)\.$/,
    classify: (m) => ({
      action: 'logind_session_new',
      outcome: 'success',
      category: 'session',
      user: m[2],
      fields: { 'session.id': m[1] },
    }),
  },
  {
    programs: LOGIND_PROGRAMS,
    pattern: /^Removed session (\S+)\.$/,
    classify: (m) => ({
      action: 'logind_session_removed',
      outcome: 'success',
      category: 'session',
      fields: { 'session.id': m[1] },
    }),
  },

  // --- PAM sessions (any program) -------------------------------------------------------
  {
    pattern:
      /^pam_unix\(([^():\s]+):session\): session opened for user ([^\s(]+)(?:\(uid=(\d+)\))? by (.*)$/,
    classify: (m) => ({
      action: 'session_opened',
      outcome: 'success',
      category: 'session',
      user: m[2],
      fields: { 'session.service': m[1], 'user.id': m[3] },
    }),
  },
  {
    pattern: /^pam_unix\(([^():\s]+):session\): session closed for user (\S+)$/,
    classify: (m) => ({
      action: 'session_closed',
      outcome: 'success',
      category: 'session',
      user: m[2],
      fields: { 'session.service': m[1] },
    }),
  },
];

/** rsyslog folds repeats: `message repeated 3 times: [ Failed password for root ...]`. */
const REPEATED = /^message repeated (\d+) times: \[ ?(.*)\]$/;

/**
 * Classify an auth.log message (the text after `program[pid]: `). Returns undefined when
 * no matcher applies. A folded repeat is classified by its inner message and carries
 * `syslog.repeat_count`.
 */
export function classifyAuthMessage(
  program: string | undefined,
  message: string,
): Classified | undefined {
  const repeated = REPEATED.exec(message);
  if (repeated) {
    // One level only: rsyslog never nests repeats, and recursion would let a crafted
    // line multiply the matching work.
    const inner = classifyPlainMessage(program, repeated[2] ?? '');
    if (!inner) return undefined;
    return {
      ...inner,
      fields: { ...inner.fields, 'syslog.repeat_count': parseCount(repeated[1]) },
    };
  }
  return classifyPlainMessage(program, message);
}

function classifyPlainMessage(
  program: string | undefined,
  message: string,
): Classified | undefined {
  const name = program?.toLowerCase();
  if (name !== undefined && SUDO_PROGRAMS.has(name)) {
    const sudo = classifySudoLine(message);
    if (sudo) return sudo;
  }
  for (const matcher of MATCHERS) {
    if (matcher.programs && (name === undefined || !matcher.programs.has(name))) continue;
    const m = matcher.pattern.exec(message);
    if (m) return matcher.classify(m);
  }
  return undefined;
}
