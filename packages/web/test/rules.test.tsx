import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockDb } from '../src/mocks/handlers';
import { currentSearch, renderApp } from './render';

async function ruleRows() {
  const table = await screen.findByRole('table', { name: 'Detection rules' });
  return within(table).getAllByRole('row').slice(1);
}

describe('rules', () => {
  it('lists rules with support status and the reason when unsupported', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/rules', language: 'en' });
    expect(await ruleRows()).toHaveLength(50);
    await user.selectOptions(screen.getByLabelText('Support'), 'false');
    expect(currentSearch(router).get('supported')).toBe('false');
    await waitFor(async () => expect(await ruleRows()).toHaveLength(2));
    for (const row of await ruleRows()) expect(row).toHaveTextContent('Unsupported');
    expect(screen.getByText(/regex:not-re2/)).toBeInTheDocument();
  });

  it('searches by technique from the URL', async () => {
    renderApp({ path: '/rules?technique=T1110.001', language: 'en' });
    const rows = await ruleRows();
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('SSH brute force followed by a successful login'),
      expect.stringContaining('SSH brute force from a single source'),
    ]);
  });

  it('shows the YAML source and attribution, and enables or disables a rule', async () => {
    const user = userEvent.setup();
    const rule = mockDb().rules.find((r) =>
      r.path.endsWith('web_sql_injection_in_access_logs.yml'),
    );
    if (!rule) throw new Error('fixture missing');
    renderApp({ path: `/rules/${rule.id}`, language: 'en' });
    const source = await screen.findByLabelText('YAML source');
    expect(source).toHaveTextContent(`id: ${rule.id}`);
    expect(source).toHaveTextContent("- 'UNION ALL SELECT'");
    expect(screen.getByText(rule.author ?? 'missing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Detection Rule License/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Disable rule' }));
    await waitFor(() => expect(rule.enabled).toBe(false));
    expect(await screen.findByRole('button', { name: 'Enable rule' })).toBeInTheDocument();
    expect(screen.getByText('Rule disabled')).toBeInTheDocument();
  });

  it('opens a rule with Enter from the table', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/rules', language: 'en' });
    const rows = await ruleRows();
    rows[0]?.focus();
    await user.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe(
      `/rules/${rows[0]?.getAttribute('data-row-id') ?? ''}`,
    );
  });
});
