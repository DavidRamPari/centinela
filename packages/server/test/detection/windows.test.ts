/**
 * Windows detection (S5): Centinela's own Windows rules on hand-built Sysmon lines, and
 * loggen's Windows data through the sysmon parser and the detector. Every Windows scenario
 * must raise its expected rules, and the workstations' background traffic must raise no
 * alert at all, at any level (S2's scenario test covers high and critical for every host).
 */
import { join } from 'node:path';
import type { NormalizedEvent } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { FILE_SOURCES, generate, type GeneratedLine } from '../../../loggen/src/index.js';
import { createDetector, loadRuleSet } from '../../src/detection/index.js';
import { sysmonParser } from '../../src/parsers/sysmon/index.js';
import { repoRoot } from '../../src/paths.js';
import type { AlertCandidate } from '../../src/pipeline/types.js';

const rulesDir = join(repoRoot, 'rules');
const RECEIVED_AT = new Date('2026-10-26T00:00:00Z');

function toEvent(line: string, id: number): NormalizedEvent {
  const parsed = sysmonParser.parse(line, {
    source: 'sysmon',
    host: 'unknown',
    receivedAt: RECEIVED_AT,
    timezone: 'UTC',
  });
  if (!parsed.ok) throw new Error(`rejected: ${parsed.reason}: ${line}`);
  return {
    ...parsed.event,
    id: `01930f6e-8a4b-7c2d-9e1f-${id.toString(16).padStart(12, '0')}`,
    ingestedAt: RECEIVED_AT.toISOString(),
  };
}

const ruleNames = new Map(
  loadRuleSet(rulesDir).rules.map(({ meta }) => [
    meta.id,
    meta.name ??
      meta.path
        .split('/')
        .pop()
        ?.replace(/\.yml$/, '') ??
      meta.id,
  ]),
);

/** Rule names that fire on the given Sysmon lines, in a fresh detector. */
function firing(lines: string[]): string[] {
  const detector = createDetector({ rulesDir });
  const candidates: AlertCandidate[] = lines.flatMap((line, i) =>
    detector.process(toEvent(line, i)),
  );
  return candidates.map((c) => ruleNames.get(c.rule.id) ?? c.rule.id);
}

const connection = (image: string, destination: string, initiated = 'true') =>
  JSON.stringify({
    EventID: 3,
    Computer: 'ws-0142',
    UtcTime: '2026-10-21 14:41:10.004',
    Image: image,
    User: 'ANDES\\m.condori',
    Protocol: 'tcp',
    Initiated: initiated,
    SourceIp: '10.20.10.42',
    SourcePort: 52114,
    DestinationIp: destination,
    DestinationPort: 80,
  });

const fileCreated = (image: string, target: string) =>
  JSON.stringify({
    EventID: 11,
    Computer: 'ws-0142',
    UtcTime: '2026-10-21 14:41:11.250',
    Image: image,
    TargetFilename: target,
    User: 'ANDES\\m.condori',
  });

const CERTUTIL = 'C:\\Windows\\System32\\certutil.exe';
const NETWORK_RULE = 'centinela-win-lolbin-network-connection';
const FILE_RULE = 'centinela-win-lolbin-file-drop';

describe("Centinela's Windows rules", () => {
  const ruleSet = loadRuleSet(rulesDir);
  const meta = (name: string) => ruleSet.rules.find((r) => r.meta.name === name)?.meta;

  it.each([
    [NETWORK_RULE, 'network_connection', ['T1105', 'T1218']],
    [FILE_RULE, 'file_event', ['T1105']],
  ])('%s: logsource, metadata and license', (name, category, techniques) => {
    expect(meta(name)).toMatchObject({
      type: 'sigma',
      logsource: { product: 'windows', category },
      level: 'medium',
      techniques,
      author: 'DavidRamPari',
      license: 'MIT',
      origin: 'centinela',
      supported: true,
      buildingBlock: false,
      url: null,
    });
    expect(meta(name)?.path).toMatch(/^rules\/centinela\/windows\//);
    expect(meta(name)?.falsepositives.length).toBeGreaterThan(0);
  });

  it.each([
    ['certutil to a public address', connection(CERTUTIL, '203.0.113.50'), true],
    [
      'mshta to a public IPv6 address',
      connection('C:\\Windows\\System32\\mshta.exe', '2001:db8::7'),
      true,
    ],
    ['certutil to the internal proxy', connection(CERTUTIL, '10.20.0.8'), false],
    ['certutil to a unique local IPv6 address', connection(CERTUTIL, 'fd00::8'), false],
    ['an inbound connection to certutil', connection(CERTUTIL, '203.0.113.50', 'false'), false],
    [
      'Chrome to a public address',
      connection('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '203.0.113.50'),
      false,
    ],
  ])('network rule on %s: %s', (_label, line, expected) => {
    expect(firing([line]).includes(NETWORK_RULE)).toBe(expected);
  });

  it.each([
    [
      'certutil writing to Public',
      fileCreated(CERTUTIL, 'C:\\Users\\Public\\Downloads\\a.txt'),
      true,
    ],
    [
      'bitsadmin writing to Temp',
      fileCreated('C:\\Windows\\System32\\bitsadmin.exe', 'C:\\Windows\\Temp\\a.exe'),
      true,
    ],
    [
      'certutil writing its URL cache',
      fileCreated(
        CERTUTIL,
        'C:\\Users\\m.condori\\AppData\\LocalLow\\Microsoft\\CryptnetUrlCache\\Content\\AB12',
      ),
      false,
    ],
    [
      'Chrome writing a download',
      fileCreated(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Users\\m.condori\\Downloads\\a.pdf',
      ),
      false,
    ],
  ])('file rule on %s', (_label, line, expected) => {
    expect(firing([line]).includes(FILE_RULE)).toBe(expected);
  });

  it('never matches process creation events (logsource routing)', () => {
    const process = JSON.stringify({
      EventID: 1,
      Computer: 'ws-0142',
      UtcTime: '2026-10-21 14:41:10.004',
      Image: CERTUTIL,
      Initiated: 'true',
      DestinationIp: '203.0.113.50',
      TargetFilename: 'C:\\Users\\Public\\a.txt',
    });
    const names = firing([process]);
    expect(names).not.toContain(NETWORK_RULE);
    expect(names).not.toContain(FILE_RULE);
  });
});

describe('loggen Windows data through the sysmon parser and the detector', () => {
  function windowsRun(small: boolean) {
    const result = generate({
      seed: 42,
      days: 3,
      startMs: Date.parse('2026-10-20T00:00:00Z'),
      small,
    });
    const lines = result.lines.filter((l) => FILE_SOURCES[l.file] === 'sysmon');
    const events = lines.map((line, i) => ({ line, event: toEvent(line.text, i) }));
    events.sort((a, b) => Date.parse(a.event.ts) - Date.parse(b.event.ts));
    const detector = createDetector({ rulesDir });
    const hits: Array<{ line: GeneratedLine; rule: string; level: string }> = [];
    for (const { line, event } of events) {
      for (const candidate of detector.process(event)) {
        hits.push({
          line,
          rule: ruleNames.get(candidate.rule.id) ?? '',
          level: candidate.rule.level,
        });
      }
    }
    return { result, lines, hits };
  }

  it.each([
    ['small', true],
    ['default 3-day', false],
  ])('%s sample: every Windows scenario fires its expected rules', (_label, small) => {
    const { result, hits } = windowsRun(small);
    const windows = result.groundTruth.scenarios.filter((s) => s.host.startsWith('ws-'));
    expect(windows).toHaveLength(8);
    const missing = windows.flatMap((truth) =>
      truth.expected
        .filter((rule) => !hits.some((h) => h.line.scenario === truth.id && h.rule === rule))
        .map((rule) => `${truth.id} → ${rule}`),
    );
    expect(missing).toEqual([]);
  });

  it('background traffic of the workstations fires no rule at any level', () => {
    const { lines, hits } = windowsRun(false);
    expect(lines.filter((l) => l.scenario === null).length).toBeGreaterThan(2000);
    const background = hits
      .filter((h) => h.line.scenario === null)
      .map((h) => `${h.level} ${h.rule}`);
    expect(background).toEqual([]);
  });
});
