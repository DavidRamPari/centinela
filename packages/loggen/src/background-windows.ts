/**
 * Background Sysmon traffic of the Windows workstations (S5). It must not trigger any
 * Windows rule: the vendored SigmaHQ process-creation rules nor Centinela's own (tested
 * at every level, not only `high`/`critical`).
 *
 * - All day: Windows housekeeping started by service hosts (scheduled-task hosts, COM
 *   surrogates, runtime brokers, background task hosts).
 * - Working days, about 08:30 to 18:30 Lima time: the user starts Outlook and Chrome,
 *   opens documents, browses through the web proxy, syncs mail, downloads files and now
 *   and then opens a PowerShell console.
 *
 * Network connections only go to internal servers (proxy, mail, file server) and files
 * land in the user's own folders.
 */
import type { Interval, WindowsHost } from './model.js';
import { WINDOWS_HOSTS } from './model.js';
import type { LineCollector } from './output.js';
import { Random } from './prng.js';
import { US_PER_MS } from './linux.js';
import {
  FILES,
  IMAGES,
  MAIL,
  PROXY,
  SysmonWriter,
  WORKSTATIONS,
  type ProcessRef,
} from './windows.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Lima is UTC−05:00 all year. */
const LIMA_OFFSET_MS = -5 * HOUR_MS;

const DOCUMENTS: Readonly<Record<WindowsHost, readonly string[]>> = {
  'ws-0142': [
    'informe-ventas-semanal.docx',
    'metas-tiendas-noviembre.xlsx',
    'propuesta-campana-verano.docx',
    'notas-reunion-equipo.txt',
  ],
  'ws-0187': [
    'cierre-octubre.xlsx',
    'presupuesto-2027.xlsx',
    'conciliacion-bancaria.xlsx',
    'notas-auditoria.txt',
  ],
};

const DOWNLOADS = [
  'catalogo-proveedor.pdf',
  'factura-proveedor-1042.pdf',
  'lista-precios-noviembre.xlsx',
  'manual-punto-de-venta.pdf',
  'reporte-inventario.csv',
];

/** Weekday (0 = Sunday) of a Lima-local day starting at `dayStartMs` (local midnight). */
function limaWeekday(dayStartMs: number): number {
  return new Date(dayStartMs - LIMA_OFFSET_MS).getUTCDay();
}

/** Poisson arrivals with the given mean gap inside [fromMs, toMs). */
function arrivals(rng: Random, fromMs: number, toMs: number, meanGapMs: number): number[] {
  const times: number[] = [];
  for (let t = fromMs + rng.exponential(meanGapMs); t < toMs; t += rng.exponential(meanGapMs)) {
    times.push(Math.floor(t));
  }
  return times;
}

function housekeeping(w: SysmonWriter, rng: Random, interval: Interval): void {
  const schedule = w.serviceHost('netsvcs -p -s Schedule');
  const dcom = w.serviceHost('DcomLaunch -p');
  for (const t of arrivals(rng, interval.fromMs, interval.toMs, 25 * MINUTE_MS)) {
    const us = t * US_PER_MS + rng.int(0, 999);
    const kind = rng.weighted(['task', 'broker', 'surrogate', 'background'], [4, 3, 2, 2]);
    if (kind === 'task') {
      w.process(us, IMAGES.taskhostw, 'taskhostw.exe', schedule);
    } else if (kind === 'broker') {
      w.process(
        us,
        IMAGES.runtimeBroker,
        'C:\\Windows\\System32\\RuntimeBroker.exe -Embedding',
        dcom,
        {
          user: w.account,
          integrity: 'Medium',
        },
      );
    } else if (kind === 'surrogate') {
      w.process(
        us,
        IMAGES.dllhost,
        'C:\\Windows\\system32\\DllHost.exe /Processid:{AB8902B4-09CA-4BB6-B78D-A8F59079A8D5}',
        dcom,
        { user: w.account, integrity: 'Medium' },
      );
    } else {
      w.process(
        us,
        IMAGES.backgroundTaskHost,
        '"C:\\Windows\\system32\\backgroundTaskHost.exe" -ServerName:BackgroundTaskHost.WebAccountProvider',
        dcom,
        { user: w.account, integrity: 'Medium' },
      );
    }
  }
}

interface UserDay {
  outlook: ProcessRef;
  chrome: ProcessRef;
}

/** Outlook and Chrome, started from the shell when the user signs in. */
function startApps(w: SysmonWriter, rng: Random, signInMs: number, inside: boolean): UserDay {
  const shell = w.shell();
  const outlookUs = (signInMs + rng.int(40, 180) * 1000) * US_PER_MS;
  const chromeUs = outlookUs + rng.int(20, 240) * 1_000_000;
  const outlookCommand = `"${IMAGES.outlook.path}" `;
  const chromeCommand = `"${IMAGES.chrome.path}" `;
  if (!inside) {
    // Started before this slice of traffic: refer to them without writing their start.
    return {
      outlook: w.existing(
        `outlook:${signInMs}`,
        IMAGES.outlook,
        outlookCommand,
        w.account,
        'Medium',
      ),
      chrome: w.existing(`chrome:${signInMs}`, IMAGES.chrome, chromeCommand, w.account, 'Medium'),
    };
  }
  return {
    outlook: w.process(outlookUs, IMAGES.outlook, outlookCommand, shell),
    chrome: w.process(chromeUs, IMAGES.chrome, chromeCommand, shell),
  };
}

function userActivity(
  w: SysmonWriter,
  rng: Random,
  apps: UserDay,
  fromMs: number,
  toMs: number,
): void {
  const { host, user } = w.ws;
  const home = `C:\\Users\\${user}`;
  const shell = w.shell();
  for (const t of arrivals(rng, fromMs, toMs, 2 * MINUTE_MS)) {
    const us = t * US_PER_MS + rng.int(0, 999);
    const kind = rng.weighted(
      ['browse', 'mail', 'tab', 'document', 'download', 'share', 'console'],
      [10, 5, 3, 2, 1, 1, 0.2],
    );
    if (kind === 'browse') {
      w.connect(us, apps.chrome, PROXY);
    } else if (kind === 'mail') {
      w.connect(us, apps.outlook, { ...MAIL, portName: 'https' });
    } else if (kind === 'tab') {
      const renderer = w.process(
        us,
        IMAGES.chrome,
        `"${IMAGES.chrome.path}" --type=renderer --lang=es-419 --renderer-client-id=${rng.int(5, 400)} ` +
          `--launch-time-ticks=${rng.int(10_000_000, 99_999_999)} /prefetch:1`,
        apps.chrome,
        { integrity: 'Low' },
      );
      w.connect(us + rng.int(200_000, 900_000), renderer, PROXY);
    } else if (kind === 'document') {
      const document = rng.pick(DOCUMENTS[host]);
      const path = `${home}\\Documents\\${document}`;
      const image = document.endsWith('.xlsx')
        ? IMAGES.excel
        : document.endsWith('.docx')
          ? IMAGES.winword
          : IMAGES.notepad;
      const commandLine =
        image === IMAGES.notepad
          ? `"${image.path}" ${path}`
          : image === IMAGES.winword
            ? `"${image.path}" /n "${path}" /o ""`
            : `"${image.path}" "${path}"`;
      const app = w.process(us, image, commandLine, shell);
      if (image !== IMAGES.notepad) {
        // Word and Excel keep an owner file next to the document (`~$` + name minus 2 characters).
        w.createFile(
          us + rng.int(1_000_000, 4_000_000),
          app,
          `${home}\\Documents\\~$${document.slice(2)}`,
        );
      }
    } else if (kind === 'download') {
      w.createFile(us, apps.chrome, `${home}\\Downloads\\${rng.pick(DOWNLOADS)}`);
    } else if (kind === 'share') {
      w.connect(us, shell, { ...FILES, portName: 'microsoft-ds' });
    } else {
      // A PowerShell console opened from the Start menu: PowerShell, but nothing a rule
      // should flag.
      w.process(us, IMAGES.powershell, `"${IMAGES.powershell.path}" `, shell);
    }
  }
}

function workdays(w: SysmonWriter, rng: Random, interval: Interval): void {
  // Lima-local midnights covering the interval.
  const firstDay =
    Math.floor((interval.fromMs + LIMA_OFFSET_MS) / DAY_MS) * DAY_MS - LIMA_OFFSET_MS;
  for (let day = firstDay; day < interval.toMs; day += DAY_MS) {
    const weekday = limaWeekday(day);
    const signIn = day + 8 * HOUR_MS + rng.int(30, 75) * MINUTE_MS;
    const signOut = day + 18 * HOUR_MS + rng.int(0, 40) * MINUTE_MS;
    if (weekday === 0 || weekday === 6) continue;
    const from = Math.max(signIn, interval.fromMs);
    const to = Math.min(signOut, interval.toMs);
    if (from >= to) continue;
    const signsInNow = signIn >= interval.fromMs;
    const apps = startApps(w, rng, signIn, signsInNow);
    userActivity(w, rng, apps, signsInNow ? signIn + 5 * MINUTE_MS : from, to);
  }
}

export function generateBackgroundWindows(
  out: LineCollector,
  seed: number,
  intervals: readonly Interval[],
): void {
  for (const host of WINDOWS_HOSTS) {
    const rng = Random.for(seed, `windows:${host}`);
    const writer = new SysmonWriter(out, WORKSTATIONS[host], rng);
    for (const interval of intervals) {
      housekeeping(writer, rng, interval);
      workdays(writer, rng, interval);
    }
  }
}
