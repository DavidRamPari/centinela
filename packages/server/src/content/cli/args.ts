/** Command-line options of `npm run content:validate`. */
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { repoRoot } from '../../paths.js';

export const VALIDATE_USAGE = `Usage: npm run content:validate -- [options]

Compiles every rule with Centinela's engine and evaluates every fixture of the content
pack against its rule's detection: positive fixtures must match, negative fixtures must
not. Writes the report and the failures file (used by tools/content-pack repair and by
the regression suite in npm test).

Options:
  --content <dir>   content folder (default: <repo>/content/sigma)
  --rules <dir>     rules folder: a folder of Sigma rules such as the rules/ folder of a
                    SigmaHQ checkout, or a Centinela rules root (with centinela/ and
                    correlation/) for Centinela's own content (default: <repo>/rules/sigma
                    for <repo>/content/sigma, <repo>/rules for any other content folder)
  --out <file>      failures file (default: <content>-failures.json next to the content folder)
  --report <file>   Markdown report (default: <repo>/docs/content-pack-report.md for
                    <repo>/content/sigma, <content>-report.md for any other content folder)
  --rejected <dir>  where --prune moves failing fixtures (default: <content>-rejected)
  --prune           move failing fixtures out of the content files, with their reason
  -h, --help        show this help
`;

const DEFAULT_CONTENT = join(repoRoot, 'content', 'sigma');

export interface ValidateArgs {
  contentDir: string;
  rulesDir: string;
  out: string;
  report: string;
  rejectedDir: string;
  prune: boolean;
}

/** Relative paths are relative to where `npm run` was started (`npm run -w` changes cwd). */
function fromInvocationDir(path: string): string {
  return resolve(process.env['INIT_CWD'] ?? process.cwd(), path);
}

/** `~/x` is expanded by the shell, but not when quoted or passed through npm scripts. */
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/** A sibling of `dir` named `<dir name><suffix>` (`content/sigma` → `content/sigma-rejected`). */
export function siblingOf(dir: string, suffix: string): string {
  return join(dirname(dir), `${basename(dir)}${suffix}`);
}

/** Paths as written into the report and the failures file: repository-relative when possible. */
export function displayPath(path: string): string {
  const rel = relative(repoRoot, path);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.split('\\').join('/');
  const home = homedir();
  const fromHome = relative(home, path);
  if (!fromHome.startsWith('..') && !isAbsolute(fromHome)) return `~/${fromHome.split('\\').join('/')}`;
  return path;
}

export function parseValidateArgs(argv: string[]): ValidateArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      content: { type: 'string' },
      rules: { type: 'string' },
      out: { type: 'string' },
      report: { type: 'string' },
      rejected: { type: 'string' },
      prune: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return 'help';
  const path = z.string().trim().min(1);
  const schema = z.object({
    content: path,
    rules: path.optional(),
    out: path.optional(),
    report: path.optional(),
    rejected: path.optional(),
  });
  const result = schema.safeParse({
    content: values.content ?? DEFAULT_CONTENT,
    rules: values.rules,
    out: values.out,
    report: values.report,
    rejected: values.rejected,
  });
  if (!result.success) {
    throw new Error(result.error.issues.map((i) => `--${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  const at = (p: string) => fromInvocationDir(expandHome(p));
  const contentDir = at(result.data.content);
  // The vendored SigmaHQ content keeps its historical defaults; other folders (Centinela's
  // own content, or another pack) default to the full rules root and a report beside them.
  const vendored = contentDir === DEFAULT_CONTENT;
  return {
    contentDir,
    rulesDir:
      result.data.rules === undefined
        ? join(repoRoot, 'rules', ...(vendored ? ['sigma'] : []))
        : at(result.data.rules),
    out: result.data.out === undefined ? siblingOf(contentDir, '-failures.json') : at(result.data.out),
    report:
      result.data.report === undefined
        ? vendored
          ? join(repoRoot, 'docs', 'content-pack-report.md')
          : siblingOf(contentDir, '-report.md')
        : at(result.data.report),
    rejectedDir:
      result.data.rejected === undefined ? siblingOf(contentDir, '-rejected') : at(result.data.rejected),
    prune: values.prune,
  };
}
