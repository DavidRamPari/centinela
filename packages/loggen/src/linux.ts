/**
 * Emitters for auth.log lines, shaped like OpenSSH 9, sudo 1.9, shadow-utils and
 * systemd-logind on Ubuntu. Times are epoch microseconds.
 */
import type { Host } from './model.js';
import type { LineCollector } from './output.js';

export const US_PER_SECOND = 1_000_000;
export const US_PER_MS = 1000;

/** One sshd connection (one sshd process, one client address and port). */
export interface SshConnection {
  out: LineCollector;
  host: Host;
  pid: number;
  ip: string;
  port: number;
}

export function sshInvalidUser(c: SshConnection, tUs: number, user: string): void {
  c.out.auth(c.host, tUs, 'sshd', c.pid, `Invalid user ${user} from ${c.ip} port ${c.port}`);
}

/** PAM's first-failure line; `user=` is only logged for accounts that exist. */
export function sshPamFailure(c: SshConnection, tUs: number, user?: string): void {
  if (user === undefined) {
    c.out.auth(c.host, tUs, 'sshd', c.pid, 'pam_unix(sshd:auth): check pass; user unknown');
  }
  const suffix = user === undefined ? '' : `  user=${user}`;
  c.out.auth(
    c.host,
    tUs,
    'sshd',
    c.pid,
    `pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=${c.ip}${suffix}`,
  );
}

export function sshFailedPassword(
  c: SshConnection,
  tUs: number,
  user: string,
  invalidUser: boolean,
): void {
  const who = invalidUser ? `invalid user ${user}` : user;
  c.out.auth(
    c.host,
    tUs,
    'sshd',
    c.pid,
    `Failed password for ${who} from ${c.ip} port ${c.port} ssh2`,
  );
}

/** sshd gives up after MaxAuthTries (6) failures on one connection. */
export function sshTooManyFailures(
  c: SshConnection,
  tUs: number,
  user: string,
  invalidUser: boolean,
): void {
  const who = invalidUser ? `invalid user ${user}` : user;
  const auth = invalidUser ? `invalid user ${user}` : `authenticating user ${user}`;
  c.out.auth(
    c.host,
    tUs,
    'sshd',
    c.pid,
    `error: maximum authentication attempts exceeded for ${who} from ${c.ip} port ${c.port} ssh2 [preauth]`,
  );
  c.out.auth(
    c.host,
    tUs + 120,
    'sshd',
    c.pid,
    `Disconnecting ${auth} ${c.ip} port ${c.port}: Too many authentication failures [preauth]`,
  );
  if (!invalidUser) {
    c.out.auth(
      c.host,
      tUs + 240,
      'sshd',
      c.pid,
      `PAM 5 more authentication failures; logname= uid=0 euid=0 tty=ssh ruser= rhost=${c.ip}  user=${user}`,
    );
  }
}

export function sshPreauthClose(
  c: SshConnection,
  tUs: number,
  user: string,
  invalidUser: boolean,
): void {
  const who = invalidUser ? 'invalid' : 'authenticating';
  c.out.auth(
    c.host,
    tUs,
    'sshd',
    c.pid,
    `Connection closed by ${who} user ${user} ${c.ip} port ${c.port} [preauth]`,
  );
}

export function sshAcceptedPassword(c: SshConnection, tUs: number, user: string): void {
  c.out.auth(
    c.host,
    tUs,
    'sshd',
    c.pid,
    `Accepted password for ${user} from ${c.ip} port ${c.port} ssh2`,
  );
}

export function sshAcceptedPublickey(
  c: SshConnection,
  tUs: number,
  user: string,
  fingerprint: string,
): void {
  c.out.auth(
    c.host,
    tUs,
    'sshd',
    c.pid,
    `Accepted publickey for ${user} from ${c.ip} port ${c.port} ssh2: ED25519 ${fingerprint}`,
  );
}

export function sshSessionOpened(c: SshConnection, tUs: number, user: string, uid: number): void {
  c.out.auth(
    c.host,
    tUs,
    'sshd',
    c.pid,
    `pam_unix(sshd:session): session opened for user ${user}(uid=${uid}) by (uid=0)`,
  );
}

/** Client logs out: disconnect, PAM session close. */
export function sshLogout(c: SshConnection, tUs: number, user: string): void {
  c.out.auth(
    c.host,
    tUs,
    'sshd',
    c.pid,
    `Received disconnect from ${c.ip} port ${c.port}:11: disconnected by user`,
  );
  c.out.auth(
    c.host,
    tUs + 150,
    'sshd',
    c.pid,
    `Disconnected from user ${user} ${c.ip} port ${c.port}`,
  );
  c.out.auth(
    c.host,
    tUs + 900,
    'sshd',
    c.pid,
    `pam_unix(sshd:session): session closed for user ${user}`,
  );
}

export function logindNewSession(
  out: LineCollector,
  host: Host,
  tUs: number,
  pid: number,
  sessionId: number,
  user: string,
): void {
  out.auth(host, tUs, 'systemd-logind', pid, `New session ${sessionId} of user ${user}.`);
}

export function logindRemovedSession(
  out: LineCollector,
  host: Host,
  tUs: number,
  pid: number,
  sessionId: number,
): void {
  out.auth(host, tUs, 'systemd-logind', pid, `Removed session ${sessionId}.`);
}

export interface SudoCall {
  out: LineCollector;
  host: Host;
  pid: number;
  user: string;
  uid: number;
  tty: string;
  pwd: string;
  command: string;
}

/** A sudo command that runs: the COMMAND= line plus the PAM session around it. */
export function sudoCommand(s: SudoCall, tUs: number, durationUs = 400_000): void {
  s.out.auth(
    s.host,
    tUs,
    'sudo',
    s.pid,
    `  ${s.user} : TTY=${s.tty} ; PWD=${s.pwd} ; USER=root ; COMMAND=${s.command}`,
  );
  s.out.auth(
    s.host,
    tUs + 2_000,
    'sudo',
    s.pid,
    `pam_unix(sudo:session): session opened for user root(uid=0) by ${s.user}(uid=${s.uid})`,
  );
  s.out.auth(
    s.host,
    tUs + durationUs,
    'sudo',
    s.pid,
    'pam_unix(sudo:session): session closed for user root',
  );
}

/** A user missing from sudoers: sudo authenticates them, then refuses. */
export function sudoNotInSudoers(s: SudoCall, tUs: number): void {
  s.out.auth(
    s.host,
    tUs,
    'sudo',
    s.pid,
    `  ${s.user} : user NOT in sudoers ; TTY=${s.tty} ; PWD=${s.pwd} ; USER=root ; COMMAND=${s.command}`,
  );
}

/** One cron job run as root: PAM session, the CMD line, session close. */
export function cronJob(
  out: LineCollector,
  host: Host,
  tUs: number,
  pid: number,
  command: string,
): void {
  out.auth(
    host,
    tUs,
    'CRON',
    pid,
    'pam_unix(cron:session): session opened for user root(uid=0) by (uid=0)',
  );
  out.auth(host, tUs + 1_500, 'CRON', pid + 1, `(root) CMD (${command})`);
  out.auth(
    host,
    tUs + 850_000,
    'CRON',
    pid,
    'pam_unix(cron:session): session closed for user root',
  );
}
