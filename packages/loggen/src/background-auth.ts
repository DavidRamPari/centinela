/**
 * Background auth.log traffic that must not trigger `high`/`critical` alerts
 * (ARCHITECTURE §4.3): cron jobs every 5 minutes, admins logging in with public keys
 * (on the bastion, sometimes a password with at most two typos first), routine sudo,
 * logind sessions, and the CI runner deploying to the web servers twice a day.
 */
import {
  ADDRESSES,
  ADMINS,
  clientPort,
  DEPLOY_UID,
  keyFingerprint,
  officeIp,
  type Admin,
} from './catalog.js';
import {
  cronJob,
  logindNewSession,
  logindRemovedSession,
  sshAcceptedPassword,
  sshAcceptedPublickey,
  sshFailedPassword,
  sshLogout,
  sshPamFailure,
  sshSessionOpened,
  sudoCommand,
  US_PER_MS,
  US_PER_SECOND,
  type SshConnection,
} from './linux.js';
import { HOSTS, WEB_HOSTS, type Host, type Interval } from './model.js';
import { localHour, type LineCollector } from './output.js';
import { Random } from './prng.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const CRON_COMMANDS: Record<Host, string> = {
  'bastion-01': '/usr/local/sbin/audit-keys --check',
  'web-01': '/usr/local/bin/ship-nginx-logs',
  'web-02': '/usr/local/bin/ship-nginx-logs',
  'db-01': '/usr/local/bin/pg-healthcheck',
};
const HOURLY_COMMAND = 'cd / && run-parts --report /etc/cron.hourly';

const ROUTINE_SUDO: Record<Host, readonly string[]> = {
  'bastion-01': [
    '/usr/bin/apt update',
    '/usr/bin/apt list --upgradable',
    '/usr/bin/systemctl status ssh',
    '/usr/bin/journalctl -u ssh --since today',
  ],
  'web-01': [
    '/usr/bin/systemctl reload nginx',
    '/usr/sbin/nginx -t',
    '/usr/bin/tail -n 200 /var/log/nginx/error.log',
    '/usr/bin/systemctl status nginx',
  ],
  'web-02': [
    '/usr/bin/systemctl reload nginx',
    '/usr/sbin/nginx -t',
    '/usr/bin/tail -n 200 /var/log/nginx/error.log',
    '/usr/bin/systemctl status nginx',
  ],
  'db-01': [
    '/usr/bin/systemctl status postgresql',
    '/usr/bin/journalctl -u postgresql --since today',
    '/usr/bin/du -sh /var/lib/postgresql',
    '/usr/bin/apt update',
  ],
};

/** Mean minutes between admin logins: [working hours, off hours]. */
const ADMIN_LOGIN_GAP_MIN: Record<Host, [number, number]> = {
  'bastion-01': [35, 240],
  'web-01': [120, 600],
  'web-02': [150, 720],
  'db-01': [100, 600],
};

function isWorkingHour(ms: number): boolean {
  const hour = localHour(ms);
  return hour >= 8 && hour < 19;
}

interface HostState {
  host: Host;
  rng: Random;
  out: LineCollector;
  nextSession: number;
  logindPid: number;
}

function cron(state: HostState, intervals: readonly Interval[]): void {
  const { host, rng, out } = state;
  for (const { fromMs, toMs } of intervals) {
    for (
      let t = Math.ceil(fromMs / (5 * MINUTE_MS)) * 5 * MINUTE_MS;
      t < toMs;
      t += 5 * MINUTE_MS
    ) {
      const startUs = t * US_PER_MS + rng.int(40_000, 900_000);
      cronJob(out, host, startUs, rng.int(20_000, 98_000), CRON_COMMANDS[host]);
    }
    for (
      let t = Math.ceil((fromMs - 17 * MINUTE_MS) / HOUR_MS) * HOUR_MS + 17 * MINUTE_MS;
      t < toMs;
      t += HOUR_MS
    ) {
      if (t < fromMs) continue;
      cronJob(
        out,
        host,
        t * US_PER_MS + rng.int(40_000, 900_000),
        rng.int(20_000, 98_000),
        HOURLY_COMMAND,
      );
    }
  }
}

interface LoginOptions {
  user: string;
  uid: number;
  ip: string;
  /** Number of mistyped passwords before success (0 = public key). */
  typos: number;
  sudoCommands: readonly string[];
  durationMs: number;
}

function interactiveSession(state: HostState, startMs: number, login: LoginOptions): void {
  const { host, rng, out } = state;
  const conn: SshConnection = {
    out,
    host,
    pid: rng.int(2_000, 99_000),
    ip: login.ip,
    port: clientPort(rng),
  };
  let t = startMs * US_PER_MS;
  for (let i = 0; i < login.typos; i += 1) {
    if (i === 0) sshPamFailure(conn, t, login.user);
    sshFailedPassword(conn, t + 2_000_000, login.user, false);
    t += rng.int(3, 9) * US_PER_SECOND;
  }
  if (login.typos > 0) sshAcceptedPassword(conn, t, login.user);
  else sshAcceptedPublickey(conn, t, login.user, keyFingerprint(rng));
  sshSessionOpened(conn, t + 25_000, login.user, login.uid);
  const sessionId = state.nextSession;
  state.nextSession += 1;
  logindNewSession(out, host, t + 60_000, state.logindPid, sessionId, login.user);

  const tty = `pts/${rng.int(0, 4)}`;
  const endUs = t + login.durationMs * US_PER_MS;
  let commandAt = t;
  for (const command of login.sudoCommands) {
    commandAt += rng.int(15, 240) * US_PER_SECOND;
    if (commandAt >= endUs) break;
    sudoCommand(
      {
        out,
        host,
        pid: rng.int(2_000, 99_000),
        user: login.user,
        uid: login.uid,
        tty,
        pwd: `/home/${login.user}`,
        command,
      },
      commandAt,
      rng.int(200_000, 8_000_000),
    );
  }
  const logoutUs = Math.max(endUs, commandAt + 10 * US_PER_SECOND);
  sshLogout(conn, logoutUs, login.user);
  logindRemovedSession(out, host, logoutUs + 2_000, state.logindPid, sessionId);
}

function adminSessions(state: HostState, intervals: readonly Interval[]): void {
  const { host, rng } = state;
  const [workGap, offGap] = ADMIN_LOGIN_GAP_MIN[host];
  for (const { fromMs, toMs } of intervals) {
    let t = fromMs;
    for (;;) {
      t += rng.exponential((isWorkingHour(t) ? workGap : offGap) * MINUTE_MS);
      if (t >= toMs) break;
      const admin: Admin = rng.pick(ADMINS);
      const onBastion = host === 'bastion-01';
      const commandCount = rng.weighted([0, 1, 2, 3], [3, 4, 2, 1]);
      const commands = Array.from({ length: commandCount }, () => rng.pick(ROUTINE_SUDO[host]));
      interactiveSession(state, t, {
        user: admin.user,
        uid: admin.uid,
        ip: onBastion ? officeIp(rng) : ADDRESSES.bastion,
        // Staff on the bastion sometimes type their password; never more than two misses.
        typos: onBastion && rng.chance(0.15) ? rng.int(1, 2) : 0,
        sudoCommands: commands,
        durationMs: rng.int(4, 90) * MINUTE_MS,
      });
    }
  }
}

/** CI deploys at about 10:05 and 16:05 Lima time on each web server. */
function deploys(state: HostState, intervals: readonly Interval[]): void {
  const { rng } = state;
  for (const { fromMs, toMs } of intervals) {
    const firstDay = Math.floor(fromMs / DAY_MS) * DAY_MS;
    for (let day = firstDay; day < toMs; day += DAY_MS) {
      for (const localTime of [10 * HOUR_MS + 5 * MINUTE_MS, 16 * HOUR_MS + 5 * MINUTE_MS]) {
        // Lima is UTC−05:00, so local 10:05 is 15:05 UTC.
        const t = day + localTime + 5 * HOUR_MS + rng.int(0, 120_000);
        if (t < fromMs || t >= toMs) continue;
        interactiveSession(state, t, {
          user: 'deploy',
          uid: DEPLOY_UID,
          ip: ADDRESSES.ciRunner,
          typos: 0,
          sudoCommands: ['/usr/bin/systemctl reload nginx'],
          durationMs: rng.int(20, 50) * 1000,
        });
      }
    }
  }
}

export function generateBackgroundAuth(
  out: LineCollector,
  seed: number,
  intervals: readonly Interval[],
): void {
  for (const host of HOSTS) {
    const rng = Random.for(seed, `auth:${host}`);
    const state: HostState = {
      host,
      rng,
      out,
      nextSession: rng.int(100, 900),
      logindPid: rng.int(600, 900),
    };
    cron(state, intervals);
    adminSessions(state, intervals);
    if (WEB_HOSTS.includes(host)) deploys(state, intervals);
  }
}
