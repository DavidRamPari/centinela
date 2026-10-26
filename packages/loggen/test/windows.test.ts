import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/generate.js';
import type { GeneratedLine } from '../src/model.js';
import { encodePowerShell, WINDOWS_SCENARIOS } from '../src/scenarios-windows.js';
import { formatSystemTime, formatUtcTime, IMAGES } from '../src/windows.js';

const START_MS = Date.parse('2026-10-20T00:00:00Z');

type Json = Record<string, unknown>;

/** Event data of a line in either shape, plus its event ID and computer. */
function eventOf(line: GeneratedLine): { id: number; computer: string; data: Json } {
  const object = JSON.parse(line.text) as Json;
  if ('Event' in object) {
    const event = object.Event as { System: Json; EventData: Json };
    return {
      id: event.System.EventID as number,
      computer: event.System.Computer as string,
      data: event.EventData,
    };
  }
  const { EventID, Computer, Channel: _channel, ...data } = object;
  return { id: EventID as number, computer: Computer as string, data };
}

describe('Windows Sysmon output', () => {
  const result = generate({ seed: 42, days: 3, startMs: START_MS, small: false });
  const sysmon = result.lines.filter((l) => l.file === 'sysmon');
  const events = sysmon.map((line) => ({ line, ...eventOf(line) }));

  it('writes event IDs 1, 3 and 11 for both workstations', () => {
    expect(sysmon.length).toBeGreaterThan(1500);
    for (const host of ['ws-0142', 'ws-0187']) {
      const ids = new Set(events.filter((e) => e.line.host === host).map((e) => e.id));
      expect([...ids].sort((a, b) => a - b)).toEqual([1, 3, 11]);
    }
    for (const e of events) expect(e.computer).toBe(e.line.host);
  });

  it('uses the nested shape on ws-0142 and the flat shape on ws-0187', () => {
    for (const { line } of events) {
      const object = JSON.parse(line.text) as Json;
      expect('Event' in object, line.host).toBe(line.host === 'ws-0142');
    }
  });

  it('writes Sysmon times in UTC that match the line time', () => {
    for (const { line, data } of events) {
      expect(data.UtcTime).toBe(formatUtcTime(line.tsUs));
    }
    expect(formatUtcTime(Date.parse('2026-10-21T14:36:05.123Z') * 1000 + 456)).toBe(
      '2026-10-21 14:36:05.123',
    );
    expect(formatSystemTime(Date.parse('2026-10-21T14:36:05.123Z') * 1000 + 456)).toBe(
      '2026-10-21T14:36:05.1234560Z',
    );
  });

  it('gives each executable consistent PE metadata', () => {
    for (const { id, data } of events.filter((e) => e.id === 1)) {
      const image = Object.values(IMAGES).find((i) => i.path === data.Image);
      if (image) {
        expect(data.OriginalFileName).toBe(image.originalFileName);
        expect(data.Description).toBe(image.description);
      } else {
        expect(data.OriginalFileName, `${id} ${String(data.Image)}`).toBe('-');
      }
      expect(data.Hashes).toMatch(
        /^SHA1=[0-9A-F]{40},MD5=[0-9A-F]{32},SHA256=[0-9A-F]{64},IMPHASH=[0-9A-F]{32}$/,
      );
    }
  });

  it('links every child to a parent GUID written by the same workstation', () => {
    for (const { line, data } of events.filter((e) => e.id === 1)) {
      const prefix = String(data.ProcessGuid).slice(0, 9);
      expect(String(data.ParentProcessGuid).slice(0, 9), line.text).toBe(prefix);
    }
  });

  it('keeps background connections internal and background files in the user folders', () => {
    const background = events.filter((e) => e.line.scenario === null);
    for (const { data } of background.filter((e) => e.id === 3)) {
      expect(String(data.DestinationIp)).toMatch(/^10\.20\.0\./);
    }
    for (const { data } of background.filter((e) => e.id === 11)) {
      expect(String(data.TargetFilename)).toMatch(
        /^C:\\Users\\(m\.condori|j\.mamani)\\(Documents|Downloads)\\/,
      );
    }
  });

  it('writes unique lines (the end-to-end test maps stored messages back to lines)', () => {
    expect(new Set(sysmon.map((l) => l.text)).size).toBe(sysmon.length);
  });

  it('starts user applications only on working days', () => {
    const weekend = generate({
      seed: 42,
      days: 2,
      startMs: Date.parse('2026-10-24T05:00:00Z'), // Saturday 00:00 in Lima
      small: false,
    });
    const lines = weekend.lines.filter((l) => l.file === 'sysmon' && l.scenario === null);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.text.includes('chrome.exe'))).toEqual([]);
  });
});

describe('Windows scenarios', () => {
  const result = generate({ seed: 42, days: 3, startMs: START_MS, small: true });
  const scenarioEvents = (id: string) =>
    result.lines.filter((l) => l.scenario === id).map((line) => ({ line, ...eventOf(line) }));

  it('tags every scenario with its workstation and ATT&CK techniques', () => {
    expect(WINDOWS_SCENARIOS.map((s) => s.id)).toEqual([
      'office-macro-powershell',
      'encoded-powershell',
      'certutil-download',
      'scheduled-task',
      'mshta-remote-hta',
      'regsvr32-scriptlet',
      'rundll32-proxy',
      'credential-dumping',
    ]);
    for (const meta of WINDOWS_SCENARIOS) {
      const events = scenarioEvents(meta.id);
      expect(events.length, meta.id).toBeGreaterThan(0);
      for (const e of events) expect(e.line.host).toBe(meta.host);
      expect(meta.techniques.length).toBeGreaterThan(0);
    }
  });

  it('happens during Lima working hours', () => {
    for (const truth of result.groundTruth.scenarios.filter((s) => s.host.startsWith('ws-'))) {
      const limaHour = (new Date(truth.start).getUTCHours() + 24 - 5) % 24;
      expect(limaHour, truth.id).toBeGreaterThanOrEqual(9);
      expect(limaHour, truth.id).toBeLessThan(18);
    }
  });

  it('has Word start PowerShell', () => {
    const [ps] = scenarioEvents('office-macro-powershell').filter(
      (e) => e.id === 1 && String(e.data.Image).endsWith('\\powershell.exe'),
    );
    expect(ps?.data.ParentImage).toBe(IMAGES.winword.path);
  });

  it('uses an encoded command that only prints a sentence', () => {
    const [ps] = scenarioEvents('encoded-powershell').filter((e) => e.id === 1);
    const encoded = /-EncodedCommand (\S+)$/.exec(String(ps?.data.CommandLine))?.[1] ?? '';
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toBe("Write-Output 'Centinela demo: encoded stage'");
    expect(encodePowerShell('A')).toBe('QQA=');
  });

  it('records the certutil download as a process, a connection and a file', () => {
    const events = scenarioEvents('certutil-download');
    expect(events.map((e) => e.id)).toEqual([1, 3, 11]);
    expect(events[1]?.data).toMatchObject({ DestinationIp: '203.0.113.50', Initiated: 'true' });
    expect(events[2]?.data.TargetFilename).toBe('C:\\Users\\Public\\Downloads\\inventario.txt');
  });

  it('keeps every command line inert: documentation addresses and no real payloads', () => {
    for (const meta of WINDOWS_SCENARIOS) {
      for (const { data } of scenarioEvents(meta.id).filter((e) => e.id === 1)) {
        const commandLine = String(data.CommandLine);
        for (const url of commandLine.matchAll(/https?:\/\/([^/\s]+)/g)) {
          expect(url[1], commandLine).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
        }
        // Nothing fetches and runs code: no IEX, DownloadString, Invoke-Expression or WebClient.
        expect(commandLine).not.toMatch(
          /iex|invoke-expression|downloadstring|webclient|frombase64/i,
        );
      }
    }
  });
});
