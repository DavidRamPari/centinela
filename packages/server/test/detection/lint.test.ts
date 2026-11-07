import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canBeginFullPath,
  checkDetectionItem,
  compareWithBaseline,
  findUnsatisfiable,
  lintFolder,
  lintRuleDocument,
  listLintFiles,
  parseLintBaseline,
  type LintFinding,
} from '../../src/detection/lint.js';
import { repoRoot } from '../../src/paths.js';

const scratch = mkdtempSync(join(tmpdir(), 'centinela-lint-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The checks of one `field|modifiers` item, as `[value, check]` pairs. */
function issues(
  key: string,
  value: unknown,
  product: string | null = null,
): Array<[string, string]> {
  const [field = '', ...modifiers] = key.split('|');
  return checkDetectionItem(field, modifiers, value, product).map((i) => [i.value, i.check]);
}

// Values are written as in a rule: `\\`, `\*` and `\?` are Sigma escapes, so a backslash
// followed by a wildcard is written `\\*`.
describe('path checks', () => {
  it('flags exact values that are not full paths', () => {
    expect(issues('Image', String.raw`\AgentExecutor.exe`)).toEqual([
      [String.raw`\AgentExecutor.exe`, 'partial-path'],
    ]);
    expect(issues('ParentImage', 'TeamViewer_Service.exe')).toEqual([
      ['TeamViewer_Service.exe', 'partial-path'],
    ]);
    expect(issues('ParentImage', String.raw`:\$WINDOWS.~BT\Sources\SetupHost.exe`)).toEqual([
      [String.raw`:\$WINDOWS.~BT\Sources\SetupHost.exe`, 'partial-path'],
    ]);
    expect(issues('TargetFilename', 'host_ip.ps1')).toEqual([['host_ip.ps1', 'partial-path']]);
    // With wildcards, the text before the first wildcard must be able to start a path.
    expect(issues('Image', String.raw`\Temp\\*.exe`)).toEqual([
      [String.raw`\Temp\\*.exe`, 'partial-path'],
    ]);
    expect(issues('Image', String.raw`C:\Users\\*\AppData\Local\Temp\\*.exe`)).toEqual([]);
    expect(issues('Image', 'C*')).toEqual([]);
  });

  it('flags exact and endswith values that end with a folder separator', () => {
    expect(
      issues('Image', ['C:\\Program Files\\Avira\\Antivirus\\', 'C:\\Windows\\explorer.exe']),
    ).toEqual([['C:\\Program Files\\Avira\\Antivirus\\', 'folder']]);
    expect(issues('Image', '/usr/bin/')).toEqual([['/usr/bin/', 'folder']]);
    expect(issues('Image', 'C:\\Users\\\\*\\AppData\\')).toEqual([
      ['C:\\Users\\\\*\\AppData\\', 'folder'],
    ]);
    expect(issues('Image|endswith', '\\AppData\\Local\\Apps\\2.0\\')).toEqual([
      ['\\AppData\\Local\\Apps\\2.0\\', 'folder'],
    ]);
    expect(issues('TargetFilename|endswith', '\\Windows\\System32\\winevt\\Logs\\')).toEqual([
      ['\\Windows\\System32\\winevt\\Logs\\', 'folder'],
    ]);
    expect(issues('Image|contains', '\\AppData\\Local\\Apps\\2.0\\')).toEqual([]);
    expect(issues('Image|startswith', 'C:\\Program Files\\Avira\\')).toEqual([]);
  });

  it('flags startswith values that no full path can begin with', () => {
    expect(issues('Image|startswith', String.raw`:\Program Files`)).toEqual([
      [String.raw`:\Program Files`, 'bad-start'],
    ]);
    expect(issues('ImageLoaded|startswith', 'C\\Windows\\WinSxS\\')).toEqual([
      ['C\\Windows\\WinSxS\\', 'bad-start'],
    ]);
    expect(issues('Image|startswith', ' C:\\Program Files\\Siber Systems\\AI RoboForm\\')).toEqual([
      [' C:\\Program Files\\Siber Systems\\AI RoboForm\\', 'bad-start'],
    ]);
    expect(issues('TargetFilename|startswith', '\\Logging\\CmdletInfra\\')).toEqual([
      ['\\Logging\\CmdletInfra\\', 'bad-start'],
    ]);
    expect(issues('Image|startswith', 'Program Files\\\\*')).toEqual([
      ['Program Files\\\\*', 'bad-start'],
    ]);
  });

  it('accepts startswith values that can begin a full path', () => {
    for (const start of [
      'C',
      'c:',
      'C:\\',
      '\\',
      '\\\\\\\\',
      '\\Dev',
      '\\Device\\',
      '\\SystemRoot\\',
      '%',
      '/tmp/',
    ]) {
      expect(issues('Image|startswith', start), start).toEqual([]);
    }
    expect(canBeginFullPath('\\??')).toBe(true);
    expect(canBeginFullPath('\\Windows')).toBe(false);
    expect(canBeginFullPath('Windows')).toBe(false);
  });

  it('accepts full paths, wildcards, other modifiers and pseudo-process names', () => {
    for (const path of [
      String.raw`C:\Windows\System32\cmd.exe`,
      String.raw`c:\windows\system32\cmd.exe`,
      String.raw`\\\\server\share\tool.exe`, // \\server\share\tool.exe
      String.raw`\Device\HarddiskVolume2\Windows\System32\cmd.exe`,
      String.raw`\SystemRoot\System32\smss.exe`,
      String.raw`\\\?\?\\C:\Windows\System32\conhost.exe`, // \??\C:\Windows\System32\conhost.exe
      String.raw`%windir%\System32\cmd.exe`,
      '/usr/bin/curl',
      'System',
      'Registry',
      'Idle',
      'vmmem',
      'vmmemWSL',
      '',
      '-',
    ]) {
      expect(issues('Image', path), path).toEqual([]);
    }
    expect(issues('Image', String.raw`*\AgentExecutor.exe`)).toEqual([]);
    expect(issues('Image|endswith', String.raw`\AgentExecutor.exe`)).toEqual([]);
    expect(issues('Image|contains', ':\\Temp\\')).toEqual([]);
    expect(issues('Image|re', '^\\\\foo\\.exe$')).toEqual([]);
    expect(issues('Image|contains|all', ['\\a\\', 'b'])).toEqual([]);
    expect(issues('Image', 42)).toEqual([]);
    expect(issues('Image', null)).toEqual([]);
  });

  it('flags the separator of another operating system', () => {
    expect(issues('Image|endswith', '/xwizard.exe', 'windows')).toEqual([
      ['/xwizard.exe', 'separator'],
    ]);
    expect(issues('TargetFilename|startswith', '/usr/share/icons/', 'windows')).toEqual([
      ['/usr/share/icons/', 'separator'],
    ]);
    expect(issues('ParentImage|endswith', '\\bash', 'linux')).toEqual([['\\bash', 'separator']]);
    expect(issues('Image|endswith', '\\node', 'macos')).toEqual([['\\node', 'separator']]);
    expect(issues('Image|endswith', '\\xwizard.exe', 'windows')).toEqual([]);
    expect(issues('Image|endswith', '/node', 'linux')).toEqual([]);
    // Without a product, either separator is a path.
    expect(issues('Image|endswith', '/node')).toEqual([]);
    expect(issues('Image|endswith', '\\node')).toEqual([]);
    // Command lines are not paths.
    expect(issues('CommandLine|contains', ' /c ', 'windows')).toEqual([]);
  });

  it('skips items with a modifier the engine does not support', () => {
    expect(issues('Image|expand', '%Admins_Workstations%')).toEqual([]);
    expect(issues('Image|nope', '\\x.exe')).toEqual([]);
  });

  it('reads values with Sigma escaping', () => {
    // `\\` is one backslash, so this value is `\server\share\tool.exe`, not a UNC path.
    const unc = String.raw`\\server\share\tool.exe`;
    expect(issues('Image', unc)).toEqual([[unc, 'partial-path']]);
    // `\*` is a literal asterisk: still an exact match on a partial path.
    expect(issues('Image', String.raw`x\*.exe`)).toEqual([[String.raw`x\*.exe`, 'partial-path']]);
    // `\\*` is a backslash followed by a wildcard.
    expect(issues('Image', String.raw`\\*\tool.exe`)).toEqual([]);
  });
});

describe('OriginalFileName check', () => {
  it('flags values with a folder separator', () => {
    expect(issues('OriginalFileName', ['\\REGSVR32.EXE', 'regsvr32.exe'])).toEqual([
      ['\\REGSVR32.EXE', 'file-name'],
    ]);
    expect(issues('OriginalFileName|endswith', '\\esentutl.exe')).toEqual([
      ['\\esentutl.exe', 'file-name'],
    ]);
    expect(issues('OriginalFileName|contains', 'tools/x')).toEqual([['tools/x', 'file-name']]);
  });

  it('accepts bare file names and wildcards', () => {
    expect(issues('OriginalFileName', ['esentutl.exe', 'Inveigh.dll'])).toEqual([]);
    expect(issues('OriginalFileName|startswith', 'psexec')).toEqual([]);
    expect(issues('OriginalFileName', 'Ps*.exe')).toEqual([]);
  });
});

describe('registry number check', () => {
  it('flags DWORD and QWORD numbers without 0x', () => {
    expect(issues('Details', 'DWORD (00000001)')).toEqual([['DWORD (00000001)', 'dword']]);
    expect(issues('Details|contains', 'qword (1')).toEqual([['qword (1', 'dword']]);
    expect(issues('Details|endswith', 'DWORD (0001)')).toEqual([['DWORD (0001)', 'dword']]);
  });

  it('accepts hexadecimal numbers and values that stop before the number', () => {
    for (const value of [
      'DWORD (0x00000001)',
      'DWORD (0X00000001)',
      'QWORD (0x00000000-0x00000001)',
      'DWORD (0',
      'DWORD (',
      'DWORD (*)',
      'DWORD (0x*',
    ]) {
      expect(issues('Details', value), value).toEqual([]);
    }
    expect(issues('Details', 'DWORD (0x0000000) DWORD (00000001)')).toEqual([
      ['DWORD (0x0000000) DWORD (00000001)', 'dword'],
    ]);
    expect(issues('NewValue', 'DWORD (00000001)')).toEqual([]);
  });
});

describe('command-line check', () => {
  it('flags exact command lines with a leading or trailing space', () => {
    expect(issues('CommandLine', [' -dhl', ' -dhd ', '--ntds-file'])).toEqual([
      [' -dhl', 'cmd-space'],
      [' -dhd ', 'cmd-space'],
    ]);
    expect(issues('ParentCommandLine', 'cmd.exe /c ')).toEqual([['cmd.exe /c ', 'cmd-space']]);
  });

  it('accepts contains, wildcards and values without outer spaces', () => {
    expect(issues('CommandLine|contains', ' -dhl')).toEqual([]);
    expect(issues('CommandLine', '* -dhl')).toEqual([]);
    expect(issues('CommandLine', 'whoami /all')).toEqual([]);
    expect(issues('CommandLine', '')).toEqual([]);
  });
});

describe('unsatisfiable exact values', () => {
  it('flags an exact value that another condition on the field rules out (Xwizard)', () => {
    expect(
      findUnsatisfiable({
        CommandLine: 'RunWizard',
        'CommandLine|re':
          '\\{[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\\}',
      }),
    ).toEqual([{ key: 'CommandLine', value: 'RunWizard', others: ['CommandLine|re'] }]);
    expect(
      findUnsatisfiable({ Image: 'C:\\a\\b.exe', 'Image|endswith': ['\\c.exe', '\\d.exe'] }),
    ).toEqual([{ key: 'Image', value: 'C:\\a\\b.exe', others: ['Image|endswith'] }]);
  });

  it('accepts an exact value that satisfies the other conditions', () => {
    expect(
      findUnsatisfiable({
        CommandLine: 'xwizard RunWizard {00000001-0000-0000-0000-0000FEEDACDC}',
        'CommandLine|re': '\\{[0-9A-F-]{36}\\}',
        'CommandLine|contains': 'runwizard',
      }),
    ).toEqual([]);
    expect(
      findUnsatisfiable({ Image: ['C:\\a\\b.exe', 'C:\\a\\c.exe'], 'Image|endswith': '\\c.exe' }),
    ).toEqual([]);
    expect(findUnsatisfiable({ Image: 'C:\\a\\b.exe', ParentImage: 'C:\\x.exe' })).toEqual([]);
  });

  it('skips fields whose other conditions the engine cannot compile', () => {
    expect(findUnsatisfiable({ Image: 'C:\\a.exe', 'Image|expand': '%x%' })).toEqual([]);
  });
});

describe('rule documents', () => {
  const rule = {
    title: 'Example',
    id: '00000000-0000-4000-8000-000000000001',
    detection: {
      selection: [{ Image: '\\tool.exe' }, { 'Image|endswith': '\\other.exe' }],
      filter: { Image: 'C:\\Program Files\\Vendor\\' },
      keywords: ['plain keyword'],
      condition: 'selection and not filter',
    },
  };

  it('reports each finding with its rule, selection and key', () => {
    const findings = lintRuleDocument(rule, 'sigma/example.yml');
    expect(findings.map((f) => [f.selection, f.key, f.value, f.check])).toEqual([
      ['selection', 'Image', '\\tool.exe', 'partial-path'],
      ['filter', 'Image', 'C:\\Program Files\\Vendor\\', 'folder'],
    ]);
    expect(findings[0]).toMatchObject({
      file: 'sigma/example.yml',
      ruleId: rule.id,
      title: 'Example',
    });
    expect(findings[0]?.message).toContain('use endswith');
  });

  it('checks separators against the rule’s logsource product', () => {
    const spark = {
      title: 'Apache Spark Shell Command Injection - ProcessCreation',
      logsource: { product: 'Linux', category: 'process_creation' },
      detection: {
        selection: { 'ParentImage|endswith': '\\bash', 'CommandLine|contains': 'id -Gn `' },
        condition: 'selection',
      },
    };
    expect(lintRuleDocument(spark, 'x.yml').map((f) => [f.key, f.check])).toEqual([
      ['ParentImage|endswith', 'separator'],
    ]);
    const windows = { ...spark, logsource: { product: 'windows' } };
    expect(lintRuleDocument(windows, 'x.yml')).toEqual([]);
  });

  it('ignores documents without a detection mapping', () => {
    expect(lintRuleDocument({ title: 'correlation', correlation: {} }, 'x.yml')).toEqual([]);
    expect(lintRuleDocument('text', 'x.yml')).toEqual([]);
    expect(lintRuleDocument(null, 'x.yml')).toEqual([]);
  });
});

describe('folders', () => {
  it('checks every YAML file of a plain folder, such as a SigmaHQ checkout', () => {
    const dir = join(scratch, 'sigmahq');
    mkdirSync(join(dir, 'windows', 'process_creation'), { recursive: true });
    writeFileSync(
      join(dir, 'windows', 'process_creation', 'broken.yml'),
      'title: Broken\nid: 1\ndetection:\n  selection:\n    Image: tool.exe\n  condition: selection\n',
    );
    writeFileSync(
      join(dir, 'windows', 'ok.yaml'),
      'title: Ok\ndetection:\n  sel:\n    Image|endswith: \\tool.exe\n  condition: sel\n',
    );
    // An old rule collection: the rule loader skips it, the lint checks each document.
    writeFileSync(
      join(dir, 'windows', 'collection.yml'),
      'title: Collection\naction: global\n---\ndetection:\n  selection:\n    ParentImage: parent.exe\n  condition: selection\n',
    );
    writeFileSync(join(dir, 'invalid.yml'), 'title: [unclosed\n');
    writeFileSync(join(dir, 'notes.txt'), 'Image: tool.exe\n');
    expect(listLintFiles(dir)).toEqual([
      'invalid.yml',
      'windows/collection.yml',
      'windows/ok.yaml',
      'windows/process_creation/broken.yml',
    ]);
    const result = lintFolder(dir);
    expect(result.files).toBe(4);
    expect(result.rules).toBe(3);
    expect(result.errors.map((e) => e.file)).toEqual(['invalid.yml']);
    expect(result.findings.map((f) => [f.file, f.key, f.check])).toEqual([
      ['windows/collection.yml', 'ParentImage', 'partial-path'],
      ['windows/process_creation/broken.yml', 'Image', 'partial-path'],
    ]);
  });

  it('uses the rule loader for a folder with Centinela’s layout (no regression samples)', () => {
    const files = listLintFiles(join(repoRoot, 'rules'));
    expect(files.some((f) => f.startsWith('sigma/regression/'))).toBe(false);
    expect(files.filter((f) => f.startsWith('sigma/')).length).toBe(1231);
    expect(files).not.toContain('lint-baseline.json');
  });
});

describe('baseline', () => {
  const finding = (file: string, key: string, check: LintFinding['check']): LintFinding => ({
    file,
    ruleId: null,
    title: null,
    selection: 'selection',
    key,
    value: 'v',
    check,
    message: '',
  });

  it('splits findings into known and new, and lists stale entries', () => {
    const baseline = parseLintBaseline(
      JSON.stringify({
        entries: [
          { file: 'a.yml', check: 'partial-path', key: 'Image', upstream: 'fixed in #1' },
          { file: 'gone.yml', check: 'folder', key: 'Image', upstream: 'fixed in #2' },
        ],
      }),
    );
    const known = finding('a.yml', 'Image', 'partial-path');
    const otherCheck = finding('a.yml', 'Image', 'folder');
    const comparison = compareWithBaseline([known, otherCheck], baseline);
    expect(comparison.known.map((k) => k.finding)).toEqual([known]);
    expect(comparison.unknown).toEqual([otherCheck]);
    expect(comparison.stale.map((e) => e.file)).toEqual(['gone.yml']);
    expect(compareWithBaseline([known], null).unknown).toEqual([known]);
  });

  it('validates the baseline file with zod', () => {
    expect(() => parseLintBaseline('{')).toThrow('baseline is not JSON');
    expect(() =>
      parseLintBaseline('{"entries":[{"file":"a","check":"nope","key":"k","upstream":"u"}]}'),
    ).toThrow('baseline: entries.0.check');
    expect(() => parseLintBaseline('{"entries":[],"extra":1}')).toThrow('baseline');
  });
});

describe('Centinela’s rules', () => {
  // The vendored SigmaHQ rules (commit 05d1031f) still have bugs that SigmaHQ fixed later;
  // rules/lint-baseline.json lists them. A new finding or a stale entry fails.
  const baseline = parseLintBaseline(
    readFileSync(join(repoRoot, 'rules', 'lint-baseline.json'), 'utf8'),
  );
  const result = lintFolder(join(repoRoot, 'rules'));
  const comparison = compareWithBaseline(result.findings, baseline);

  it('has no finding outside the baseline and no stale baseline entry', () => {
    expect(result.errors).toEqual([]);
    expect(comparison.unknown).toEqual([]);
    expect(comparison.stale).toEqual([]);
  });

  it('finds the vendored rules with a never-matching condition, by upstream status', () => {
    const byUpstream = new Map<string, Set<string>>();
    for (const { finding, entry } of comparison.known) {
      const files = byUpstream.get(entry.upstream) ?? new Set<string>();
      files.add(finding.file.replace('sigma/windows/process_creation/proc_creation_win_', ''));
      byUpstream.set(entry.upstream, files);
    }
    const sorted = (upstream: string) => [...(byUpstream.get(upstream) ?? [])].sort();
    expect(sorted('fixed in SigmaHQ/sigma#6546')).toEqual([
      'xwizard_runwizard_com_object_exec.yml',
    ]);
    expect(sorted('fixed in SigmaHQ/sigma#6549')).toEqual([
      'esentutl_sensitive_file_copy.yml',
      'hktl_inveigh.yml',
      'msiexec_dll.yml',
      'msiexec_masquerading.yml',
      'mssql_sqltoolsps_susp_execution.yml',
      'rpcping_credential_capture.yml',
      'susp_use_of_te_bin.yml',
    ]);
    expect(sorted('fixed in SigmaHQ/sigma#6565')).toEqual(['dump64_defender_av_bypass_rename.yml']);
    expect(sorted('fixed in SigmaHQ/sigma#6567')).toEqual([
      'agentexecutor_potential_abuse.yml',
      'hktl_quarks_pwdump.yml',
      'powershell_non_interactive_execution.yml',
      'remote_access_tools_teamviewer_incoming_connection.yml',
    ]);
    expect(sorted('not fixed upstream yet (SigmaHQ master 53b90df6, 2026-11-06)')).toEqual([
      'regsvr32_remote_share.yml',
    ]);
    expect(byUpstream.size).toBe(5);
  });
});
