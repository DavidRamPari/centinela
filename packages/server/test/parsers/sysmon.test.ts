import { normalizedEventSchema, type NormalizedEvent } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { logsourcesFor } from '../../src/db/logsources.js';
import { MAX_LINE_LENGTH } from '../../src/parsers/common.js';
import { MAX_DATA_FIELDS } from '../../src/parsers/sysmon/fields.js';
import { parseSysmonTime, sysmonParser } from '../../src/parsers/sysmon/index.js';
import type { IngestContext } from '../../src/pipeline/types.js';

const ctx: IngestContext = {
  source: 'sysmon',
  host: 'fallback-host',
  receivedAt: new Date('2026-10-26T12:00:00Z'),
  timezone: 'America/Lima',
};

type Event = Omit<NormalizedEvent, 'id' | 'ingestedAt'>;

function parse(line: string): Event {
  const result = sysmonParser.parse(line, ctx);
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  normalizedEventSchema.parse({
    ...result.event,
    id: '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f',
    ingestedAt: '2026-10-26T12:00:00.000Z',
  });
  return result.event;
}

function rejection(line: string): string {
  const result = sysmonParser.parse(line, ctx);
  if (result.ok) throw new Error('accepted');
  return result.reason;
}

const PROCESS_DATA = {
  RuleName: '-',
  UtcTime: '2026-10-21 14:36:05.123',
  ProcessGuid: '{4F2A7C11-6B3E-6716-1A02-000000001F00}',
  ProcessId: 7412,
  Image: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  FileVersion: '10.0.19041.3996 (WinBuild.160101.0800)',
  Description: 'Windows PowerShell',
  Product: 'Microsoft® Windows® Operating System',
  Company: 'Microsoft Corporation',
  OriginalFileName: 'PowerShell.EXE',
  CommandLine: 'powershell.exe -NoProfile -Command "Write-Output demo"',
  CurrentDirectory: 'C:\\Users\\m.condori\\Documents\\',
  User: 'ANDES\\m.condori',
  LogonId: '0x5d3a1',
  IntegrityLevel: 'Medium',
  Hashes: 'SHA256=0000000000000000000000000000000000000000000000000000000000000000',
  ParentProcessId: '5120',
  ParentImage: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
  ParentCommandLine: '"C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE" /n',
  ParentUser: 'ANDES\\m.condori',
};

function nested(eventId: unknown, data: Record<string, unknown> | null, system = {}): string {
  return JSON.stringify({
    Event: {
      '#attributes': { xmlns: 'http://schemas.microsoft.com/win/2004/08/events/event' },
      System: {
        Provider: { '#attributes': { Name: 'Microsoft-Windows-Sysmon' } },
        EventID: eventId,
        TimeCreated: { '#attributes': { SystemTime: '2026-10-21T14:36:05.1300000Z' } },
        Channel: 'Microsoft-Windows-Sysmon/Operational',
        Computer: 'ws-0142',
        ...system,
      },
      EventData: data,
    },
  });
}

const flat = (fields: Record<string, unknown>) =>
  JSON.stringify({ EventID: 1, Computer: 'ws-0187', ...fields });

describe('sysmon parser: event ID 1 (process creation)', () => {
  it('keeps every EventData key as a Sigma field, unchanged, and adds ECS keys', () => {
    const event = parse(nested(1, PROCESS_DATA));
    expect(event).toMatchObject({
      ts: '2026-10-21T14:36:05.123Z',
      source: 'sysmon',
      host: 'ws-0142',
      logsources: [{ product: 'windows', category: 'process_creation' }],
      category: 'process',
      action: 'process_start',
      outcome: 'success',
      user: 'm.condori',
    });
    expect(event.srcIp).toBeUndefined();
    for (const [key, value] of Object.entries(PROCESS_DATA)) expect(event.fields[key]).toBe(value);
    expect(event.fields).toMatchObject({
      EventID: 1,
      Computer: 'ws-0142',
      'event.action': 'process_start',
      'event.category': 'process',
      'event.outcome': 'success',
      'host.name': 'ws-0142',
      'user.name': 'm.condori',
      'user.domain': 'ANDES',
      'process.name': 'powershell.exe',
      'process.executable': PROCESS_DATA.Image,
      'process.pid': 7412,
      'process.command_line': PROCESS_DATA.CommandLine,
      'process.parent.name': 'WINWORD.EXE',
      'process.parent.executable': PROCESS_DATA.ParentImage,
      'process.parent.pid': 5120,
      'process.parent.command_line': PROCESS_DATA.ParentCommandLine,
    });
  });

  it('stores the line as received as the message', () => {
    const line = nested(1, PROCESS_DATA);
    expect(parse(line).message).toBe(line);
  });

  it('gives the same fields for the flat shape', () => {
    const fromNested = parse(nested(1, PROCESS_DATA));
    const fromFlat = parse(flat({ ...PROCESS_DATA, Computer: 'ws-0142' }));
    expect(fromFlat.fields).toEqual(fromNested.fields);
    expect({ ...fromFlat, message: '' }).toEqual({ ...fromNested, message: '' });
  });

  it('matches field names case-sensitively: other spellings stay separate fields', () => {
    const event = parse(flat({ ...PROCESS_DATA, commandline: 'other', IMAGE: 'x' }));
    expect(event.fields.CommandLine).toBe(PROCESS_DATA.CommandLine);
    expect(event.fields.commandline).toBe('other');
    expect(event.fields.Image).toBe(PROCESS_DATA.Image);
    expect(event.fields.IMAGE).toBe('x');
  });

  it.each([
    ['a number', 1],
    ['a digit string', '1'],
    ['an XML text node', { '#text': '1', '#attributes': { Qualifiers: '' } }],
  ])('reads EventID given as %s', (_label, eventId) => {
    expect(parse(nested(eventId, PROCESS_DATA)).action).toBe('process_start');
  });

  it('takes a user without a domain as it is', () => {
    const event = parse(flat({ ...PROCESS_DATA, User: 'svc_backup' }));
    expect(event.user).toBe('svc_backup');
    expect(event.fields['user.domain']).toBeUndefined();
  });

  it('has no user when User is absent or "-"', () => {
    const { User: _user, ...data } = PROCESS_DATA;
    expect(parse(flat(data)).user).toBeUndefined();
    expect(parse(flat({ ...data, User: '-' })).user).toBeUndefined();
  });
});

describe('sysmon parser: event IDs 3, 11 and others', () => {
  const network = {
    UtcTime: '2026-10-21 14:41:10.004',
    ProcessId: 8120,
    Image: 'C:\\Windows\\System32\\certutil.exe',
    User: 'ANDES\\m.condori',
    Protocol: 'tcp',
    Initiated: 'true',
    SourceIsIpv6: 'false',
    SourceIp: '10.20.10.42',
    SourceHostname: 'ws-0142.andes-retail.example',
    SourcePort: '52114',
    DestinationIsIpv6: 'false',
    DestinationIp: '203.0.113.50',
    DestinationPort: 80,
    DestinationPortName: 'http',
  };

  it('maps a network connection (3), with the source as srcIp and the destination in fields', () => {
    const event = parse(nested(3, network));
    expect(event).toMatchObject({
      ts: '2026-10-21T14:41:10.004Z',
      logsources: [{ product: 'windows', category: 'network_connection' }],
      category: 'network',
      action: 'network_connection',
      outcome: 'success',
      user: 'm.condori',
      srcIp: '10.20.10.42',
      srcPort: 52114,
    });
    expect(event.fields).toMatchObject({
      'source.ip': '10.20.10.42',
      'source.port': 52114,
      'destination.ip': '203.0.113.50',
      'destination.port': 80,
      'network.transport': 'tcp',
      'network.direction': 'egress',
      'process.name': 'certutil.exe',
      Initiated: 'true',
      DestinationIp: '203.0.113.50',
    });
  });

  it('normalizes IPv6 and IPv4-mapped addresses and reads inbound connections', () => {
    const event = parse(
      flat({
        ...network,
        EventID: 3,
        Initiated: false,
        SourceIp: '::ffff:10.20.10.7',
        DestinationIp: '2001:DB8:0:0:0:0:0:1',
      }),
    );
    expect(event.srcIp).toBe('10.20.10.7');
    expect(event.fields['destination.ip']).toBe('2001:db8::1');
    expect(event.fields['network.direction']).toBe('ingress');
  });

  it('ignores addresses and ports that are not valid', () => {
    const event = parse(
      flat({
        ...network,
        EventID: 3,
        SourceIp: 'ws-0142',
        SourcePort: '99999',
        DestinationIp: '-',
      }),
    );
    expect(event.srcIp).toBeUndefined();
    expect(event.srcPort).toBeUndefined();
    expect(event.fields['destination.ip']).toBeUndefined();
  });

  it('maps a file creation (11)', () => {
    const event = parse(
      nested(11, {
        UtcTime: '2026-10-21 14:41:11.250',
        ProcessId: 8120,
        Image: 'C:\\Windows\\System32\\certutil.exe',
        TargetFilename: 'C:\\Users\\Public\\Downloads\\inventario.txt',
        CreationUtcTime: '2026-10-21 14:41:11.250',
        User: 'ANDES\\m.condori',
      }),
    );
    expect(event).toMatchObject({
      logsources: [{ product: 'windows', category: 'file_event' }],
      category: 'file',
      action: 'file_create',
      outcome: 'success',
    });
    expect(event.srcIp).toBeUndefined();
    expect(event.fields).toMatchObject({
      'file.path': 'C:\\Users\\Public\\Downloads\\inventario.txt',
      'file.name': 'inventario.txt',
      TargetFilename: 'C:\\Users\\Public\\Downloads\\inventario.txt',
    });
  });

  it.each([5, 13, 22])('maps event ID %i to `other` with the windows logsource', (id) => {
    const event = parse(nested(id, { UtcTime: '2026-10-21 14:41:11.250', Image: 'C:\\x.exe' }));
    expect(event).toMatchObject({
      logsources: [{ product: 'windows' }],
      category: 'other',
      action: 'other',
      outcome: 'unknown',
    });
    expect(event.fields.EventID).toBe(id);
  });

  it("reads another provider's event 1 as `other`, never as a process start", () => {
    const system = { Provider: { '#attributes': { Name: 'Microsoft-Windows-Kernel-General' } } };
    expect(parse(nested(1, PROCESS_DATA, system)).action).toBe('other');
    expect(parse(flat({ ...PROCESS_DATA, Channel: 'System' })).action).toBe('other');
    expect(
      parse(flat({ ...PROCESS_DATA, Channel: 'Microsoft-Windows-Sysmon/Operational' })).action,
    ).toBe('process_start');
  });

  it('gives the logsources that reading events back from the database rebuilds', () => {
    for (const id of [1, 3, 11, 7]) {
      const event = parse(nested(id, PROCESS_DATA));
      expect(event.logsources).toEqual(logsourcesFor('sysmon', event.action, event.fields));
    }
  });
});

describe('sysmon parser: time and host', () => {
  it('prefers UtcTime, then the envelope time', () => {
    const { UtcTime: _time, ...data } = PROCESS_DATA;
    expect(parse(nested(1, data)).ts).toBe('2026-10-21T14:36:05.130Z');
    expect(parse(flat({ ...data, TimeCreated: '2026-10-21T14:36:06Z' })).ts).toBe(
      '2026-10-21T14:36:06.000Z',
    );
    // An unreadable UtcTime falls back to the next one.
    expect(parse(nested(1, { ...data, UtcTime: 'yesterday' })).ts).toBe('2026-10-21T14:36:05.130Z');
  });

  it('reads UtcTime as UTC whatever the ingest time zone', () => {
    expect(parseSysmonTime('2026-10-21 14:36:05.123')).toBe(Date.parse('2026-10-21T14:36:05.123Z'));
    expect(parseSysmonTime('2026-10-21T14:36:05.1234567Z')).toBe(
      Date.parse('2026-10-21T14:36:05.123Z'),
    );
    expect(parseSysmonTime('2026-10-21T09:36:05-05:00')).toBe(Date.parse('2026-10-21T14:36:05Z'));
    expect(parseSysmonTime('2026-02-30 10:00:00.000')).toBeUndefined();
  });

  it('rejects events without a usable time', () => {
    const { UtcTime: _time, ...data } = PROCESS_DATA;
    expect(rejection(flat(data))).toBe('missing timestamp');
    expect(rejection(flat({ ...data, UtcTime: '21/10/2026' }))).toBe('invalid timestamp');
  });

  it('takes the host from Computer, else from the ingest context', () => {
    const { Computer: _c, ...rest } = JSON.parse(flat(PROCESS_DATA)) as Record<string, unknown>;
    expect(parse(JSON.stringify(rest)).host).toBe('fallback-host');
    expect(parse(flat({ ...PROCESS_DATA, Computer: '  ' })).host).toBe('fallback-host');
  });
});

describe('sysmon parser: hostile and malformed input', () => {
  it.each([
    ['not JSON', 'Oct 25 14:03:12 host sshd[1]: hello', 'invalid JSON'],
    ['truncated JSON', '{"EventID": 1, "UtcTime": "2026', 'invalid JSON'],
    ['a JSON array', '[1, 2]', 'not a JSON object'],
    ['a JSON string', '"text"', 'not a JSON object'],
    ['null', 'null', 'not a JSON object'],
    ['an object without EventID', '{"Image": "C:\\\\x.exe"}', 'not a Sysmon event'],
    ['an out-of-range EventID', '{"EventID": 70000, "UtcTime": "2026-10-21"}', 'not a Sysmon'],
    ['a negative EventID', '{"EventID": -1, "UtcTime": "2026-10-21 14:00:00"}', 'not a Sysmon'],
    ['a nested event without System', '{"Event": {"EventData": {}}}', 'not a Sysmon event'],
    ['EventData that is not an object', nested(1, null).replace('null', '"x"'), 'not a Sysmon'],
  ])('rejects %s', (_label, line, reason) => {
    expect(rejection(line)).toContain(reason);
  });

  it('accepts a nested event without EventData', () => {
    const event = parse(nested(1, null));
    expect(event.ts).toBe('2026-10-21T14:36:05.130Z');
    expect(event.fields.Image).toBeUndefined();
  });

  it('rejects lines longer than the parser limit instead of cutting the JSON', () => {
    const line = flat({ ...PROCESS_DATA, CommandLine: 'a'.repeat(MAX_LINE_LENGTH) });
    expect(rejection(line)).toBe('line too long');
  });

  it('cuts long values to 8,192 characters', () => {
    const event = parse(flat({ ...PROCESS_DATA, CommandLine: `cmd.exe /c ${'A'.repeat(20_000)}` }));
    expect(event.fields.CommandLine).toHaveLength(8192);
    expect(event.fields['process.command_line']).toHaveLength(8192);
    expect(event.message).toHaveLength(8192);
  });

  it('keeps out keys that are not Windows field names, so data cannot overwrite ECS keys', () => {
    const line =
      '{"EventID":1,"UtcTime":"2026-10-21 14:36:05.123","Image":"C:\\\\a.exe",' +
      '"event.action":"ssh_login","host.name":"evil","@timestamp":"x","__proto__":{"polluted":true},' +
      '"constructor":"c","1abc":"d","a b":"e"}';
    const event = parse(line);
    expect(event.fields['event.action']).toBe('process_start');
    expect(event.fields['host.name']).toBe('fallback-host');
    expect(Object.keys(event.fields)).not.toContain('@timestamp');
    expect(Object.keys(event.fields)).not.toContain('1abc');
    expect(Object.keys(event.fields)).not.toContain('a b');
    expect(Object.hasOwn(event.fields, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(event.fields)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(event.fields.constructor).toBe('c');
  });

  it('replaces NUL characters and lone surrogates so the event can be stored', () => {
    const event = parse(
      flat({ ...PROCESS_DATA, CommandLine: 'a\u0000b\ud800c', Computer: 'ws\u00000142' }),
    );
    expect(event.fields.CommandLine).toBe('a\uFFFDb\uFFFDc');
    expect(event.host).toBe('ws\uFFFD0142');
    expect(event.message).not.toContain('\u0000');
  });

  it('turns objects and arrays in event data into JSON text', () => {
    const event = parse(flat({ ...PROCESS_DATA, Details: { a: [1, 2] }, List: ['x', 'y'] }));
    expect(event.fields.Details).toBe('{"a":[1,2]}');
    expect(event.fields.List).toBe('["x","y"]');
  });

  it('survives values nested too deeply to serialize again', () => {
    const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`;
    const line = `{"EventID":1,"UtcTime":"2026-10-21 14:36:05.123","Deep":${deep}}`;
    expect(parse(line).fields.Deep).toBe('');
  });

  it(`keeps at most ${MAX_DATA_FIELDS} event data fields`, () => {
    const many = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`F${i}`, i]));
    const event = parse(flat({ UtcTime: '2026-10-21 14:36:05.123', ...many }));
    expect(Object.keys(event.fields).filter((k) => /^F\d+$/.test(k))).toHaveLength(
      MAX_DATA_FIELDS - 3,
    );
  });

  it('parses hostile command lines as plain text', () => {
    const hostile = `<script>alert(1)</script>' OR 1=1-- ${'(a+)+'.repeat(100)}`;
    const event = parse(flat({ ...PROCESS_DATA, CommandLine: hostile }));
    expect(event.fields.CommandLine).toBe(hostile);
  });
});
