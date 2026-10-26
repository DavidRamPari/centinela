/**
 * Windows Sysmon events for the "Andes Retail" workstations (S5): process creation (event
 * ID 1), network connection (3) and file creation (11), written one JSON object per line
 * in either of the shapes the `sysmon` parser accepts (ARCHITECTURE §4.4):
 *
 * - `ws-0142` exports the nested `Event.System` / `Event.EventData` shape, as Windows
 *   event forwarding tools and SigmaHQ's regression samples do;
 * - `ws-0187` ships the flat shape (`{"EventID": 1, "Computer": ..., "Image": ...}`).
 *
 * Event data follows Sysmon 15's field names and order. Sysmon writes times in UTC
 * (`UtcTime: 2026-10-21 14:36:05.123`), so these lines carry no Lima offset.
 *
 * Every executable comes with consistent PE metadata (`OriginalFileName`, `Description`,
 * ...): SigmaHQ's "renamed binary" rules compare them with `Image`. Hashes are derived
 * from the path with a fixed seed, so an executable keeps its hash across runs and seeds.
 */
import type { LineCollector } from './output.js';
import type { WindowsHost } from './model.js';
import { Random } from './prng.js';

export type SysmonShape = 'nested' | 'flat';

export interface Workstation {
  host: WindowsHost;
  /** Account name without the domain. */
  user: string;
  ip: string;
  shape: SysmonShape;
}

export const DOMAIN = 'ANDES';
export const SYSTEM = 'NT AUTHORITY\\SYSTEM';
/** Internal services the workstations talk to (10.20.0.0/24, ARCHITECTURE §4.3). */
export const PROXY = { ip: '10.20.0.8', port: 3128, hostname: 'proxy-01.andes-retail.example' };
export const MAIL = { ip: '10.20.0.25', port: 443, hostname: 'mail.andes-retail.example' };
export const FILES = { ip: '10.20.0.40', port: 445, hostname: 'files-01.andes-retail.example' };

export const WORKSTATIONS: Readonly<Record<WindowsHost, Workstation>> = {
  /** Sales: Marisol Condori (fictional). */
  'ws-0142': { host: 'ws-0142', user: 'm.condori', ip: '10.20.10.42', shape: 'nested' },
  /** Finance: Julio Mamani (fictional). */
  'ws-0187': { host: 'ws-0187', user: 'j.mamani', ip: '10.20.10.87', shape: 'flat' },
};

export interface ImageInfo {
  path: string;
  originalFileName: string;
  description: string;
  product: string;
  company: string;
  fileVersion: string;
}

const WINDOWS_PRODUCT = 'Microsoft® Windows® Operating System';
const MICROSOFT = 'Microsoft Corporation';
const WINDOWS_VERSION = '10.0.22621.4317 (WinBuild.160101.0800)';
const OFFICE = 'C:\\Program Files\\Microsoft Office\\root\\Office16';

function system32(
  name: string,
  originalFileName: string,
  description: string,
  product = WINDOWS_PRODUCT,
): ImageInfo {
  return {
    path: `C:\\Windows\\System32\\${name}`,
    originalFileName,
    description,
    product,
    company: MICROSOFT,
    fileVersion: WINDOWS_VERSION,
  };
}

function office(name: string, originalFileName: string, description: string): ImageInfo {
  return {
    path: `${OFFICE}\\${name}`,
    originalFileName,
    description,
    product: 'Microsoft Office',
    company: MICROSOFT,
    fileVersion: '16.0.18025.20160',
  };
}

export const IMAGES = {
  services: system32('services.exe', 'services.exe', 'Services and Controller app'),
  svchost: system32('svchost.exe', 'svchost.exe', 'Host Process for Windows Services'),
  taskhostw: system32('taskhostw.exe', 'taskhostw.exe', 'Host Process for Windows Tasks'),
  runtimeBroker: system32('RuntimeBroker.exe', 'RuntimeBroker.exe', 'Runtime Broker'),
  backgroundTaskHost: system32(
    'backgroundTaskHost.exe',
    'backgroundTaskHost.exe',
    'Background Task Host',
  ),
  dllhost: system32('dllhost.exe', 'dllhost.exe', 'COM Surrogate'),
  explorer: {
    ...system32('explorer.exe', 'EXPLORER.EXE', 'Windows Explorer'),
    path: 'C:\\Windows\\explorer.exe',
  },
  notepad: system32('notepad.exe', 'NOTEPAD.EXE', 'Notepad'),
  powershell: {
    ...system32('powershell.exe', 'PowerShell.EXE', 'Windows PowerShell'),
    path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  },
  certutil: system32('certutil.exe', 'CertUtil.exe', 'CertUtil.exe'),
  mshta: system32(
    'mshta.exe',
    'MSHTA.EXE',
    'Microsoft (R) HTML Application host',
    'Internet Explorer',
  ),
  regsvr32: system32('regsvr32.exe', 'REGSVR32.EXE', 'Microsoft(C) Register Server'),
  rundll32: system32('rundll32.exe', 'RUNDLL32.EXE', 'Windows host process (Rundll32)'),
  schtasks: system32('schtasks.exe', 'schtasks.exe', 'Task Scheduler Configuration Tool'),
  cmd: system32('cmd.exe', 'Cmd.Exe', 'Windows Command Processor'),
  chrome: {
    path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    originalFileName: 'chrome.exe',
    description: 'Google Chrome',
    product: 'Google Chrome',
    company: 'Google LLC',
    fileVersion: '130.0.6723.70',
  },
  winword: office('WINWORD.EXE', 'WinWord.exe', 'Microsoft Word'),
  excel: office('EXCEL.EXE', 'Excel.exe', 'Microsoft Excel'),
  outlook: office('OUTLOOK.EXE', 'Outlook.exe', 'Microsoft Outlook'),
} as const satisfies Record<string, ImageInfo>;

/** An executable without version information (Sysmon writes `-` for each field). */
export function unsignedImage(path: string): ImageInfo {
  return {
    path,
    originalFileName: '-',
    description: '-',
    product: '-',
    company: '-',
    fileVersion: '-',
  };
}

/** A running process, as later events (children, connections, files) refer to it. */
export interface ProcessRef {
  image: ImageInfo;
  guid: string;
  pid: number;
  commandLine: string;
  /** `DOMAIN\name` or `NT AUTHORITY\SYSTEM`. */
  user: string;
  integrity: string;
}

export interface ProcessOptions {
  /** Defaults to the parent's user. */
  user?: string;
  /** Defaults to the parent's integrity level. */
  integrity?: string;
  currentDirectory?: string;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** Sysmon's `UtcTime`: `2026-10-21 14:36:05.123`. */
export function formatUtcTime(tsUs: number): string {
  const date = new Date(Math.floor(tsUs / 1000));
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}` +
    `.${pad(date.getUTCMilliseconds(), 3)}`
  );
}

/** The event log's `SystemTime`, with 100-nanosecond precision: `...T14:36:05.1234560Z`. */
export function formatSystemTime(tsUs: number): string {
  const date = new Date(Math.floor(tsUs / 1000));
  const micros = pad(((tsUs % 1_000_000) + 1_000_000) % 1_000_000, 6);
  return `${date.toISOString().slice(0, 19)}.${micros}0Z`;
}

const SYSMON_PROVIDER = {
  '#attributes': {
    Name: 'Microsoft-Windows-Sysmon',
    Guid: '{5770385F-C22A-43E0-BF4C-06F5698FFBD9}',
  },
};
const SYSMON_CHANNEL = 'Microsoft-Windows-Sysmon/Operational';
/** Event ID → Sysmon task number (the System `Task` element). */
const TASKS: Readonly<Record<number, number>> = { 1: 1, 3: 3, 11: 11 };

/** Hex digits from a fixed-seed stream: stable for a label across runs and seeds. */
function stableHex(label: string, length: number): string {
  return Random.for(0, label).hex(length).toUpperCase();
}

function hashesOf(image: ImageInfo): string {
  return (
    `SHA1=${stableHex(`sha1:${image.path}`, 40)},MD5=${stableHex(`md5:${image.path}`, 32)},` +
    `SHA256=${stableHex(`sha256:${image.path}`, 64)},IMPHASH=${stableHex(`imphash:${image.path}`, 32)}`
  );
}

/**
 * Writes the Sysmon events of one workstation. Process GUIDs, process ids and source
 * ports come from the writer's own seeded stream.
 */
export class SysmonWriter {
  private readonly machinePrefix: string;
  private readonly logonGuid: string;
  private readonly logonId: string;

  constructor(
    private readonly out: LineCollector,
    readonly ws: Workstation,
    private readonly rng: Random,
  ) {
    this.machinePrefix = stableHex(`machine:${ws.host}`, 8);
    this.logonGuid = `{${this.machinePrefix}-${stableHex(`logon:${ws.host}`, 4)}-6716-0000-0000000000000000}`;
    this.logonId = `0x${stableHex(`logonid:${ws.host}`, 5).toLowerCase()}`;
  }

  /** `DOMAIN\user` of the workstation's user. */
  get account(): string {
    return `${DOMAIN}\\${this.ws.user}`;
  }

  /**
   * A long-running process that started before the log (services, the user's shell); no
   * event is written for it. Its GUID and pid depend only on the host and `label`, so
   * background traffic and scenarios agree on them.
   */
  existing(
    label: string,
    image: ImageInfo,
    commandLine: string,
    user: string,
    integrity: string,
  ): ProcessRef {
    const hex = stableHex(`process:${this.ws.host}:${label}`, 20);
    return {
      image,
      guid: `{${this.machinePrefix}-${hex.slice(0, 4)}-6715-${hex.slice(4, 8)}-${hex.slice(8, 20)}}`,
      pid: Random.for(0, `pid:${this.ws.host}:${label}`).int(100, 2_000) * 4,
      commandLine,
      user,
      integrity,
    };
  }

  /** The signed-in user's shell (`explorer.exe`, medium integrity). */
  shell(): ProcessRef {
    return this.existing(
      'explorer',
      IMAGES.explorer,
      'C:\\Windows\\Explorer.EXE',
      this.account,
      'Medium',
    );
  }

  /** A service host started by the service control manager (`svchost.exe -k <group>`). */
  serviceHost(group: string): ProcessRef {
    return this.existing(
      `svchost:${group}`,
      IMAGES.svchost,
      `C:\\Windows\\system32\\svchost.exe -k ${group}`,
      SYSTEM,
      'System',
    );
  }

  /** Event ID 1. Returns the new process for its own children and activity. */
  process(
    tsUs: number,
    image: ImageInfo,
    commandLine: string,
    parent: ProcessRef,
    options: ProcessOptions = {},
  ): ProcessRef {
    const child: ProcessRef = {
      image,
      guid: this.newGuid(),
      pid: this.newPid(),
      commandLine,
      user: options.user ?? parent.user,
      integrity: options.integrity ?? parent.integrity,
    };
    const system = child.user.startsWith('NT AUTHORITY\\');
    this.write(tsUs, 1, {
      RuleName: '-',
      UtcTime: formatUtcTime(tsUs),
      ProcessGuid: child.guid,
      ProcessId: child.pid,
      Image: image.path,
      FileVersion: image.fileVersion,
      Description: image.description,
      Product: image.product,
      Company: image.company,
      OriginalFileName: image.originalFileName,
      CommandLine: commandLine,
      CurrentDirectory:
        options.currentDirectory ??
        (system ? 'C:\\Windows\\system32\\' : `C:\\Users\\${this.ws.user}\\`),
      User: child.user,
      LogonGuid: system ? `{${this.machinePrefix}-0000-0000-E703-000000000000}` : this.logonGuid,
      LogonId: system ? '0x3e7' : this.logonId,
      TerminalSessionId: system ? 0 : 1,
      IntegrityLevel: child.integrity,
      Hashes: hashesOf(image),
      ParentProcessGuid: parent.guid,
      ParentProcessId: parent.pid,
      ParentImage: parent.image.path,
      ParentCommandLine: parent.commandLine,
      ParentUser: parent.user,
    });
    return child;
  }

  /** Event ID 3: an outbound TCP connection from the workstation. */
  connect(
    tsUs: number,
    process: ProcessRef,
    destination: { ip: string; port: number; hostname?: string; portName?: string },
  ): void {
    this.write(tsUs, 3, {
      RuleName: '-',
      UtcTime: formatUtcTime(tsUs),
      ProcessGuid: process.guid,
      ProcessId: process.pid,
      Image: process.image.path,
      User: process.user,
      Protocol: 'tcp',
      Initiated: 'true',
      SourceIsIpv6: 'false',
      SourceIp: this.ws.ip,
      SourceHostname: `${this.ws.host}.andes-retail.example`,
      SourcePort: this.rng.int(49_152, 65_535),
      SourcePortName: '-',
      DestinationIsIpv6: 'false',
      DestinationIp: destination.ip,
      DestinationHostname: destination.hostname ?? '-',
      DestinationPort: destination.port,
      DestinationPortName: destination.portName ?? '-',
    });
  }

  /** Event ID 11: a file created by the process. */
  createFile(tsUs: number, process: ProcessRef, targetFilename: string): void {
    this.write(tsUs, 11, {
      RuleName: '-',
      UtcTime: formatUtcTime(tsUs),
      ProcessGuid: process.guid,
      ProcessId: process.pid,
      Image: process.image.path,
      TargetFilename: targetFilename,
      CreationUtcTime: formatUtcTime(tsUs),
      User: process.user,
    });
  }

  private write(tsUs: number, eventId: number, data: Record<string, string | number>): void {
    const us = Math.round(tsUs);
    const object =
      this.ws.shape === 'nested'
        ? {
            Event: {
              System: {
                Provider: SYSMON_PROVIDER,
                EventID: eventId,
                Version: 5,
                Level: 4,
                Task: TASKS[eventId] ?? 0,
                Opcode: 0,
                Keywords: '0x8000000000000000',
                // The event log stamps the record a moment after the event itself.
                TimeCreated: { '#attributes': { SystemTime: formatSystemTime(us + 1_500) } },
                Correlation: null,
                Channel: SYSMON_CHANNEL,
                Computer: this.ws.host,
                Security: { '#attributes': { UserID: 'S-1-5-18' } },
              },
              EventData: data,
            },
          }
        : { EventID: eventId, Computer: this.ws.host, Channel: SYSMON_CHANNEL, ...data };
    this.out.sysmon(this.ws.host, us, JSON.stringify(object));
  }

  private newGuid(): string {
    const hex = this.rng.hex(20).toUpperCase();
    return `{${this.machinePrefix}-${hex.slice(0, 4)}-6716-${hex.slice(4, 8)}-${hex.slice(8, 20)}}`;
  }

  /** Windows process ids are multiples of four. */
  private newPid(): number {
    return this.rng.int(250, 4_000) * 4;
  }
}
