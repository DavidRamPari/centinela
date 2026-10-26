// @vitest-environment node
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/** The repository's ESLint config rejects raw HTML rendering in the web package (CLAUDE.md). */
describe('dangerouslySetInnerHTML ban', () => {
  const eslint = new ESLint({ cwd: new URL('../../..', import.meta.url).pathname });
  // Linted as if it were an existing file, so the type-aware config applies unchanged.
  const filePath = new URL('../src/pages/NotFoundPage.tsx', import.meta.url).pathname;

  async function messages(code: string) {
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax');
  }

  it('rejects the JSX attribute and the createElement prop', async () => {
    const jsx = await messages(
      'export function X({ html }: { html: string }) {\n  return <div dangerouslySetInnerHTML={{ __html: html }} />;\n}\n',
    );
    expect(jsx).toHaveLength(1);
    expect(jsx[0]?.message).toContain('attacker-controlled');
    const props = await messages(
      "import { createElement } from 'react';\nexport const y = (html: string) => createElement('div', { dangerouslySetInnerHTML: { __html: html } });\n",
    );
    expect(props).toHaveLength(1);
  }, 30_000);

  it('accepts rendering text', async () => {
    expect(
      await messages(
        'export function X({ text }: { text: string }) {\n  return <div>{text}</div>;\n}\n',
      ),
    ).toHaveLength(0);
  }, 30_000);
});
