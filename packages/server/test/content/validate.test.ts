import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../../src/paths.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFailuresFile, failuresFileSchema, fixtureKey } from '../../src/content/failures.js';
import { pruneFailures, rejectedFileSchema } from '../../src/content/prune.js';
import { buildContentReport, contentSummary, percent } from '../../src/content/report.js';
import {
  isRulesRoot,
  listSigmaRuleFiles,
  loadRuleFolder,
  loadSigmaFolder,
  sigmaFolderOf,
} from '../../src/content/rules.js';
import { canonicalJson } from '../../src/content/schema.js';
import {
  readContentDir,
  validateContent,
  type ContentValidation,
  type RuleOutcome,
} from '../../src/content/validate.js';

const IDS = {
  cmd: '11111111-1111-4111-8111-111111111111',
  keywords: '22222222-2222-4222-8222-222222222222',
  expand: '33333333-3333-4333-8333-333333333333',
  deprecated: '44444444-4444-4444-8444-444444444444',
  bare: '55555555-5555-4555-8555-555555555555',
  alternatives: '66666666-6666-4666-8666-666666666666',
  orphan: '99999999-9999-4999-8999-999999999999',
};

const RULES: Record<string, string> = {
  'windows/process_creation/cmd_whoami.yml': `title: Whoami Through Cmd
id: ${IDS.cmd}
status: test
author: Test Author
logsource: { product: windows, category: process_creation }
detection:
  selection:
    Image|endswith: '\\cmd.exe'
    CommandLine|contains: '/c whoami'
  filter:
    User|contains: 'SYSTEM'
  condition: selection and not filter
level: medium
`,
  'linux/builtin/wget_keywords.yml': `title: Wget Download
id: ${IDS.keywords}
status: test
logsource: { product: linux }
detection:
  keywords:
    - 'wget http'
  condition: keywords
level: low
`,
  'windows/process_creation/expand.yml': `title: Placeholder Rule
id: ${IDS.expand}
status: test
logsource: { product: windows, category: process_creation }
detection:
  selection:
    CommandLine|expand: '%admins%'
  condition: selection
level: low
`,
  'windows/process_creation/old.yml': `title: Old Rule
id: ${IDS.deprecated}
status: deprecated
logsource: { product: windows, category: process_creation }
detection:
  selection:
    Image: x
  condition: selection
level: low
`,
  'web/bare.yml': `title: Rule Without Content
id: ${IDS.bare}
status: test
logsource: { category: webserver }
detection:
  selection:
    cs-method: TRACE
  condition: selection
level: low
`,
  'windows/process_creation/alternatives.yml': `title: Two Ways
id: ${IDS.alternatives}
status: test
logsource: { product: windows, category: process_creation }
detection:
  selection:
    - Image|endswith: '\\a.exe'
      CommandLine|contains: 'alpha'
    - Image|endswith: '\\b.exe'
      CommandLine|contains: 'beta'
  condition: selection
level: low
`,
  // Not a rule folder: SigmaHQ regression data. Invalid YAML proves it is never read.
  'regression/broken.yml': 'title: [unclosed',
};

const playbook = {
  summary: 'Summary.',
  what_it_detects: 'What.',
  why_it_matters: 'Why.',
  triage_steps: ['Step one.'],
  false_positives: ['Admins.'],
  response_steps: ['Contain.'],
  severity_rationale: 'Because.',
};

type Event = Record<string, unknown>;

function content(id: string, positive: Event[], negative: Event[]) {
  const fixture = (event: Event, index: number) => ({ description: `fixture ${index}`, event });
  return {
    rule: { id, title: 'From the generator', path: 'x.yml', author: 'Test Author', url: null, license: 'DRL-1.1' },
    playbook: { es: playbook, en: playbook },
    fixtures: { positive: positive.map(fixture), negative: negative.map(fixture) },
    generated: { tool: 'content-pack/1', model: 'm', at: '2026-10-25T00:00:00Z', review: 'unreviewed', notice: 'AI-generated.' },
  };
}

const CMD = 'C:\\Windows\\System32\\cmd.exe';

let root: string;
let rulesDir: string;
let contentDir: string;

function writeJson(path: string, data: unknown) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'centinela-content-'));
  rulesDir = join(root, 'rules');
  contentDir = join(root, 'content', 'sigma');
  for (const [path, text] of Object.entries(RULES)) {
    mkdirSync(join(rulesDir, path, '..'), { recursive: true });
    writeFileSync(join(rulesDir, path), text);
  }
  mkdirSync(contentDir, { recursive: true });
  writeJson(
    join(contentDir, `${IDS.cmd}.json`),
    content(
      IDS.cmd,
      [
        { Image: CMD, CommandLine: 'cmd.exe /c whoami /all', User: 'ANDES\\jperez' },
        { Image: CMD, User: 'ANDES\\jperez' },
      ],
      [
        { Image: CMD, CommandLine: 'cmd.exe /c whoami', User: 'NT AUTHORITY\\SYSTEM' },
        { Image: CMD, CommandLine: 'cmd.exe /C WHOAMI', User: 'ANDES\\jperez' },
      ],
    ),
  );
  writeJson(
    join(contentDir, `${IDS.keywords}.json`),
    content(
      IDS.keywords,
      [
        { message: 'Oct 25 14:03:12 bastion-01 sudo: deploy : COMMAND=/usr/bin/wget http://203.0.113.7/x' },
        { CommandLine: 'wget http://198.51.100.2/y' },
      ],
      [{ message: 'Oct 25 14:03:12 bastion-01 sudo: deploy : COMMAND=/usr/bin/wget --version' }],
    ),
  );
  writeJson(join(contentDir, `${IDS.expand}.json`), content(IDS.expand, [{ CommandLine: 'x' }], [{ CommandLine: 'y' }]));
  writeJson(
    join(contentDir, `${IDS.alternatives}.json`),
    content(IDS.alternatives, [{ Image: 'C:\\b.exe', CommandLine: 'gamma' }], [{ Image: 'C:\\c.exe' }]),
  );
  writeJson(join(contentDir, `${IDS.orphan}.json`), content(IDS.orphan, [{ a: 1 }], [{ a: 2 }]));
  writeFileSync(join(contentDir, 'broken.json'), '{ not json');
  writeJson(join(contentDir, 'shape.json'), { rule: { id: IDS.bare, title: 't' } });
  writeFileSync(join(contentDir, 'README.txt'), 'not content');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(): ContentValidation {
  return validateContent(loadSigmaFolder(rulesDir), readContentDir(contentDir));
}

function outcome(validation: ContentValidation, id: string): RuleOutcome {
  const rule = validation.evaluated.find((r) => r.ruleId === id);
  if (!rule) throw new Error(`no outcome for ${id}`);
  return rule;
}

describe('loading a Sigma rules folder', () => {
  it('walks every rule file except regression data', () => {
    expect(listSigmaRuleFiles(rulesDir)).toEqual([
      'linux/builtin/wget_keywords.yml',
      'web/bare.yml',
      'windows/process_creation/alternatives.yml',
      'windows/process_creation/cmd_whoami.yml',
      'windows/process_creation/expand.yml',
      'windows/process_creation/old.yml',
    ]);
    const folder = loadSigmaFolder(rulesDir);
    expect(folder.ruleSet.errors).toEqual([]);
    const meta = folder.ruleSet.rule(IDS.cmd)?.meta;
    expect(meta?.license).toBe('DRL-1.1');
    expect(folder.relPath(meta?.path ?? '')).toBe('windows/process_creation/cmd_whoami.yml');
  });
});

describe('validateContent', () => {
  it('sorts content into evaluated, unsupported, orphan and malformed files', () => {
    const v = run();
    expect(v.contentFiles).toBe(7);
    expect(v.evaluated.map((r) => r.ruleId)).toEqual([IDS.cmd, IDS.keywords, IDS.alternatives]);
    expect(v.unsupported).toEqual([
      expect.objectContaining({ ruleId: IDS.expand, reason: 'modifier:expand', fixtures: 2 }),
    ]);
    expect(v.orphans).toEqual([{ file: `${IDS.orphan}.json`, reason: expect.stringContaining(IDS.orphan) as string }]);
    expect(v.malformed.map((m) => [m.file, m.reason.split(' (')[0]])).toEqual([
      ['broken.json', 'invalid JSON'],
      ['shape.json', 'invalid content'],
    ]);
    // Deprecated rules never get content; the rule without a file is listed.
    expect(v.rulesTotal).toBe(5);
    expect(v.rulesUnsupported).toBe(1);
    expect(v.missing.map((r) => r.rulePath)).toEqual(['web/bare.yml']);
  });

  it('passes positives that match and negatives that do not, case-insensitively', () => {
    const fixtures = outcome(run(), IDS.cmd).fixtures;
    expect(fixtures.map((f) => [f.kind, f.index, f.passed])).toEqual([
      ['positive', 0, true],
      ['positive', 1, false],
      ['negative', 0, true],
      ['negative', 1, false],
    ]);
    expect(fixtures[0]?.reason).toBeNull();
  });

  it('explains a positive that does not match: the selection and the failing item', () => {
    const failed = outcome(run(), IDS.cmd).fixtures[1];
    expect(failed?.reason).toBe(
      'expected a match, but the condition "selection and not filter" is false: ' +
        'selection did not match (failed: CommandLine|contains: field missing)',
    );
    expect(failed?.selections).toEqual([
      { name: 'selection', matched: false },
      { name: 'filter', matched: false },
    ]);
  });

  it('explains a negative that matches, including the filter that should have excluded it', () => {
    const failed = outcome(run(), IDS.cmd).fixtures[3];
    expect(failed?.reason).toBe(
      'expected no match, but the condition "selection and not filter" is true: ' +
        'selection matched (matched: Image|endswith; CommandLine|contains); filter did not match (failed: User|contains)',
    );
  });

  it('names the closest alternative of a list of maps', () => {
    const [positive, negative] = outcome(run(), IDS.alternatives).fixtures;
    expect(positive?.reason).toBe(
      'expected a match, but the condition "selection" is false: ' +
        'selection did not match (closest alternative failed: CommandLine|contains)',
    );
    expect(negative?.passed).toBe(true);
  });

  it("matches keywords against the event's message, or its JSON text without one", () => {
    const fixtures = outcome(run(), IDS.keywords).fixtures;
    expect(fixtures.map((f) => f.passed)).toEqual([true, true, true]);
  });
});

describe('failures file and report', () => {
  it('lists every failing fixture with its event and reason', () => {
    const v = run();
    const file = buildFailuresFile(v, { rulesDir: 'rules', contentDir: 'content/sigma', pruned: false });
    expect(failuresFileSchema.parse(JSON.parse(JSON.stringify(file)))).toEqual(file);
    expect(file.summary).toEqual({ rules: 3, fixtures: 9, passed: 6, failed: 3 });
    expect(file.failures.map((f) => [f.ruleId, f.kind, f.index])).toEqual([
      [IDS.cmd, 'positive', 1],
      [IDS.cmd, 'negative', 1],
      [IDS.alternatives, 'positive', 0],
    ]);
    expect(file.failures[0]?.event).toEqual({ Image: CMD, User: 'ANDES\\jperez' });
    expect(file.unsupported.map((u) => u.ruleId)).toEqual([IDS.expand]);
  });

  it('identifies a fixture by rule, kind, index and event, ignoring key order', () => {
    expect(fixtureKey(IDS.cmd.toUpperCase(), 'positive', 1, { b: 1, a: 'x' })).toBe(
      fixtureKey(IDS.cmd, 'positive', 1, { a: 'x', b: 1 }),
    );
    expect(fixtureKey(IDS.cmd, 'positive', 1, { a: 'x' })).not.toBe(fixtureKey(IDS.cmd, 'negative', 1, { a: 'x' }));
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });

  it('writes pass rates, failures, unsupported rules and unusable files to the report', () => {
    const v = run();
    const report = buildContentReport(v, {
      rulesDir: 'rules/sigma',
      contentDir: 'content/sigma',
      failuresFile: 'content/sigma-failures.json',
      pruned: false,
    });
    expect(report).toContain('| **Fixtures passing** | **6 / 9 (66.6%)** |');
    expect(report).toContain('| `windows/process_creation` | 2 | 0 | 3 / 6 | 50.0% |');
    expect(report).toContain('### Whoami Through Cmd');
    expect(report).toContain('- positive #1: fixture 1');
    expect(report).toContain('- `windows/process_creation/expand.yml` (Placeholder Rule): `modifier:expand`');
    expect(report).toContain('- `web/bare.yml` (Rule Without Content)');
    expect(report).toContain('- `broken.json`: invalid JSON');
    expect(contentSummary(v)).toContain('fixtures passing: 6 / 9 (66.6%)');
  });

  it('never rounds a partial pass rate up to 100%', () => {
    expect(percent(2428, 2429)).toBe('99.9%');
    expect(percent(5, 5)).toBe('100.0%');
    expect(percent(0, 0)).toBe('—');
  });

  it('keeps hostile text from rule titles out of the Markdown structure', () => {
    const v = run();
    const rule = v.evaluated[0];
    if (!rule) throw new Error('no rule');
    const hostile = { ...v, evaluated: [{ ...rule, title: '<script>x</script> | `y`' }] };
    const report = buildContentReport(hostile, { rulesDir: 'r', contentDir: 'c', failuresFile: 'f', pruned: false });
    expect(report).toContain('### \\<script\\>x\\</script\\> \\| \\`y\\`');
  });
});

describe('pruneFailures', () => {
  it('moves failing fixtures to the rejected folder with their reason and keeps the rest', () => {
    const v = run();
    const rejectedDir = join(root, 'content', 'sigma-rejected');
    expect(pruneFailures(contentDir, rejectedDir, v.evaluated)).toEqual({ files: 2, fixtures: 3 });

    const pruned = JSON.parse(readFileSync(join(contentDir, `${IDS.cmd}.json`), 'utf8')) as {
      fixtures: { positive: unknown[]; negative: unknown[] };
      playbook: unknown;
    };
    expect(pruned.fixtures.positive).toHaveLength(1);
    expect(pruned.fixtures.negative).toHaveLength(1);
    expect(pruned.playbook).toEqual({ es: playbook, en: playbook });

    const rejected = rejectedFileSchema.parse(
      JSON.parse(readFileSync(join(rejectedDir, `${IDS.cmd}.json`), 'utf8')) as unknown,
    );
    expect(rejected.rule).toEqual({ id: IDS.cmd, title: 'Whoami Through Cmd', path: 'windows/process_creation/cmd_whoami.yml' });
    expect(rejected.rejected.map((r) => [r.kind, r.index])).toEqual([
      ['positive', 1],
      ['negative', 1],
    ]);
    expect(rejected.rejected[0]?.reason).toContain('field missing');

    // Validating again finds nothing to prune, and every remaining fixture passes.
    const again = run();
    expect(again.evaluated.every((r) => r.fixtures.every((f) => f.passed))).toBe(true);
    expect(pruneFailures(contentDir, rejectedDir, again.evaluated)).toEqual({ files: 0, fixtures: 0 });
  });

  it('refuses to drop a fixture that changed after it was evaluated', () => {
    const v = run();
    const path = join(contentDir, `${IDS.cmd}.json`);
    const changed = content(IDS.cmd, [{ a: 1 }, { b: 2 }], [{ c: 3 }, { d: 4 }]);
    writeJson(path, changed);
    expect(() => pruneFailures(contentDir, join(root, 'rejected'), v.evaluated)).toThrow(/changed/);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(changed);
  });
});

describe("Centinela's own rules (a rules root)", () => {
  const BASE = '77777777-7777-4777-8777-777777777777';
  const UNCOVERED = '88888888-8888-4888-8888-888888888888';
  const CORRELATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const NO_FIXTURES = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const SIGMA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  function baseRule(id: string, name: string): string {
    return `title: Rule ${name}
id: ${id}
name: ${name}
status: experimental
author: DavidRamPari
logsource: { product: linux, service: sshd }
detection:
  selection:
    event.action: ssh_login
    event.outcome: failure
  condition: selection
level: low
`;
  }

  function setUp(): { rulesRoot: string; content: string } {
    const rulesRoot = join(root, 'repo-rules');
    const files: Record<string, string> = {
      'centinela/linux/a.yml': baseRule(BASE, 'test-auth-failure'),
      'centinela/linux/b.yml': baseRule(UNCOVERED, 'test-uncovered'),
      'centinela/linux/c.yml': baseRule(NO_FIXTURES, 'test-no-fixtures'),
      'correlation/burst.yml': `title: Burst of failures
id: ${CORRELATION}
name: test-burst
status: experimental
author: DavidRamPari
correlation:
  type: event_count
  rules:
    - test-auth-failure
  group-by:
    - source.ip
  timespan: 5m
  condition:
    gte: 10
level: high
`,
      // SigmaHQ rules in the root are not expected to have Centinela content.
      'sigma/s.yml': RULES['web/bare.yml']?.replace(IDS.bare, SIGMA) ?? '',
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(rulesRoot, path, '..'), { recursive: true });
      writeFileSync(join(rulesRoot, path), text);
    }
    const dir = join(root, 'content', 'centinela');
    mkdirSync(dir, { recursive: true });
    const failure = { 'event.action': 'ssh_login', 'event.outcome': 'failure', 'source.ip': '203.0.113.45' };
    writeJson(join(dir, `${BASE}.json`), content(BASE, [failure], [{ ...failure, 'event.outcome': 'success' }]));
    const { fixtures: _none, ...playbookOnly } = content(CORRELATION, [], []);
    writeJson(join(dir, `${CORRELATION}.json`), playbookOnly);
    writeJson(join(dir, `${NO_FIXTURES}.json`), { ...content(NO_FIXTURES, [], []), fixtures: undefined });
    return { rulesRoot, content: dir };
  }

  it('loads a rules root with the engine loader and expects content for Centinela rules only', () => {
    const { rulesRoot, content: dir } = setUp();
    expect(isRulesRoot(rulesRoot)).toBe(true);
    expect(isRulesRoot(rulesDir)).toBe(false);
    const folder = loadRuleFolder(rulesRoot);
    expect(folder.ruleSet.rule(CORRELATION)?.meta.supported).toBe(true);
    expect(folder.ruleSet.rule(BASE)?.meta.license).toBe('MIT');

    const v = validateContent(folder, readContentDir(dir));
    expect(v.evaluated.map((r) => [r.rulePath, r.fixtures.map((f) => f.passed)])).toEqual([
      ['centinela/linux/a.yml', [true, true]],
    ]);
    expect(v.playbookOnly).toEqual([
      { ruleId: CORRELATION, title: 'Burst of failures', rulePath: 'correlation/burst.yml', file: `${CORRELATION}.json`, ignoredFixtures: 0 },
    ]);
    expect(v.malformed).toEqual([
      { file: `${NO_FIXTURES}.json`, reason: 'no fixtures (only correlation rules may have a playbook only)' },
    ]);
    expect(v.missing.map((r) => r.rulePath)).toEqual(['centinela/linux/b.yml']);
    expect(v.rulesTotal).toBe(4);

    const report = buildContentReport(v, { rulesDir: 'rules', contentDir: 'content/centinela', failuresFile: 'f', pruned: false });
    expect(report).toContain('| Correlation rules with a playbook only (not evaluated) | 1 |');
    expect(report).toContain('- `correlation/burst.yml` (Burst of failures)');
    expect(contentSummary(v)).toContain('correlation playbooks (not evaluated): 1');
  });

  it('ignores, and counts, fixtures given to a correlation rule', () => {
    const { rulesRoot, content: dir } = setUp();
    writeJson(join(dir, `${CORRELATION}.json`), content(CORRELATION, [{ a: 1 }], [{ b: 2 }]));
    const v = validateContent(loadRuleFolder(rulesRoot), readContentDir(dir));
    expect(v.playbookOnly[0]?.ignoredFixtures).toBe(2);
    expect(v.evaluated.map((r) => r.ruleId)).toEqual([BASE]);
  });
});

describe('SigmaHQ folders other than rules/', () => {
  const HUNT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  it('knows which SigmaHQ folder a rules folder belongs to', () => {
    expect(sigmaFolderOf(join(repoRoot, 'rules', 'sigma'))).toBe('rules');
    expect(sigmaFolderOf('/home/david/sigmahq/rules-emerging-threats')).toBe('rules-emerging-threats');
    expect(sigmaFolderOf('/home/david/sigmahq/rules-threat-hunting/windows')).toBe('rules-threat-hunting');
    expect(sigmaFolderOf('/home/david/sigmahq/rules/windows')).toBe('rules');
    expect(sigmaFolderOf('/srv/my-sigma')).toBeNull();
  });

  it('validates only the content files of that folder and counts the others', () => {
    const huntDir = join(root, 'sigmahq', 'rules-threat-hunting');
    mkdirSync(join(huntDir, 'windows'), { recursive: true });
    writeFileSync(
      join(huntDir, 'windows', 'hunt.yml'),
      (RULES['windows/process_creation/cmd_whoami.yml'] ?? '').replace(IDS.cmd, HUNT),
    );
    const pack = join(root, 'pack');
    mkdirSync(pack);
    const hunt = content(
      HUNT,
      [{ Image: CMD, CommandLine: 'cmd.exe /c whoami', User: 'ANDES\\jperez' }],
      [{ Image: CMD, CommandLine: 'cmd.exe /c dir' }],
    );
    writeJson(join(pack, `${HUNT}.json`), { ...hunt, rule: { ...hunt.rule, folder: 'rules-threat-hunting' } });
    // Content for rules/ (no folder recorded) and for another folder share the content folder.
    writeJson(join(pack, `${IDS.cmd}.json`), content(IDS.cmd, [{ a: 1 }], [{ b: 2 }]));
    const emerging = content(IDS.keywords, [{ a: 1 }], [{ b: 2 }]);
    writeJson(join(pack, `${IDS.keywords}.json`), {
      ...emerging,
      rule: { ...emerging.rule, folder: 'rules-emerging-threats' },
    });

    const folder = loadSigmaFolder(huntDir);
    expect(folder.folder).toBe('rules-threat-hunting');
    const v = validateContent(folder, readContentDir(pack));
    expect(v.contentFiles).toBe(3);
    expect(v.otherFolders).toBe(2);
    expect(v.orphans).toEqual([]);
    expect(v.evaluated.map((r) => [r.rulePath, r.fixtures.map((f) => f.passed)])).toEqual([
      ['windows/hunt.yml', [true, true]],
    ]);
    const report = buildContentReport(v, { rulesDir: 'r', contentDir: 'c', failuresFile: 'f', pruned: false });
    expect(report).toContain('| Content files for other SigmaHQ folders (skipped) | 2 |');

    // The rules/ folder sees the same pack the other way round.
    const rulesFolder = loadSigmaFolder(rulesDir);
    expect(rulesFolder.folder).toBe('rules');
    const fromRules = validateContent(rulesFolder, readContentDir(pack));
    expect(fromRules.otherFolders).toBe(2);
    expect(fromRules.evaluated.map((r) => r.ruleId)).toEqual([IDS.cmd]);
  });
});
