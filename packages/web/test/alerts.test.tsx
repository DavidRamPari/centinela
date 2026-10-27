import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockDb } from '../src/mocks/handlers';
import { currentSearch, renderApp } from './render';

async function alertRows() {
  const table = await screen.findByRole('table', { name: /Alerts, newest first/ });
  return within(table).getAllByRole('row').slice(1);
}

function alertByTitle(title: string) {
  const alert = mockDb().alerts.find((a) => a.ruleTitle === title);
  if (!alert) throw new Error(`no fixture alert ${title}`);
  return alert;
}

describe('alerts list', () => {
  it('filters by level with the chips and keeps the filter in the URL', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/alerts', language: 'en' });
    const before = await alertRows();
    await user.click(
      within(screen.getByRole('group', { name: 'Level' })).getByRole('button', { name: 'High' }),
    );

    expect(currentSearch(router).get('level')).toBe('high');
    await waitFor(async () => expect((await alertRows()).length).toBeLessThan(before.length));
    for (const row of await alertRows()) {
      expect(row.querySelector('[data-level]')).toHaveAttribute('data-level', 'high');
    }
    expect(
      within(screen.getByRole('group', { name: 'Level' })).getByRole('button', { name: 'High' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('applies text filters on submit and reads them back from the URL', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/alerts', language: 'en' });
    await alertRows();
    await user.type(screen.getByLabelText('Host'), 'web-02{Enter}');
    expect(currentSearch(router).get('host')).toBe('web-02');
    await waitFor(async () => {
      const rows = await alertRows();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toHaveTextContent('web-02');
    });
  });

  it('starts from a technique in the URL (links from the ATT&CK matrix)', async () => {
    renderApp({ path: '/alerts?technique=T1110.003', language: 'en' });
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('SSH password spraying from a single source');
    expect(screen.getByLabelText('ATT&CK technique')).toHaveValue('T1110.003');
  });

  it('acknowledges the selected alerts in bulk', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/alerts', language: 'en' });
    await alertRows();
    const button = screen.getByRole('button', { name: 'Acknowledge selected' });
    expect(button).toBeDisabled();

    await user.click(
      screen.getByRole('checkbox', { name: 'Select alert Cross Site Scripting Strings' }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Select alert JNDIExploit Pattern' }));
    expect(screen.getByText('Selected: 2')).toBeInTheDocument();
    await user.click(button);

    expect(await screen.findByText('Alerts acknowledged: 2')).toBeInTheDocument();
    expect(alertByTitle('Cross Site Scripting Strings').status).toBe('acknowledged');
    expect(alertByTitle('JNDIExploit Pattern').status).toBe('acknowledged');
    await waitFor(() => expect(screen.getByText('Selected: 0')).toBeInTheDocument());
  });

  it('opens an alert with the keyboard (arrow keys, then Enter)', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/alerts', language: 'en' });
    const rows = await alertRows();
    rows[0]?.focus();
    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(rows[rows.length - 1]).toHaveFocus();
    await user.keyboard('{Home}{ArrowDown}{Enter}');
    expect(router.state.location.pathname).toBe(
      `/alerts/${rows[1]?.getAttribute('data-row-id') ?? ''}`,
    );
    expect(
      await screen.findByRole('heading', { name: 'Timeline of related events' }),
    ).toBeInTheDocument();
  });
});

describe('alert detail', () => {
  it('acknowledges, closes with a resolution and reopens an alert', async () => {
    const user = userEvent.setup();
    const alert = alertByTitle('Cross Site Scripting Strings');
    renderApp({ path: `/alerts/${alert.id}`, language: 'en' });
    // The panel remounts after every change (fresh form state), so look it up each time.
    const triagePanel = async () =>
      within(
        (await screen.findByRole('heading', { name: 'Triage' })).closest('section') as HTMLElement,
      );
    let triage = await triagePanel();

    await user.click(triage.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(alert.status).toBe('acknowledged'));
    expect(await screen.findByText('Alert updated')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument(),
    );

    triage = await triagePanel();
    const close = triage.getByRole('button', { name: 'Close alert' });
    expect(close).toBeDisabled();
    await user.selectOptions(triage.getByLabelText('Resolution'), 'false_positive');
    await user.type(triage.getByLabelText('Note'), 'QA team test');
    await user.click(close);
    await waitFor(() => expect(alert.status).toBe('closed'));
    expect(alert.resolution).toBe('false_positive');
    expect(alert.note).toBe('QA team test');

    await user.click(await screen.findByRole('button', { name: 'Reopen alert' }));
    await waitFor(() => expect(alert.status).toBe('new'));
    expect(alert.resolution).toBeNull();
  });

  it('shows the DRL 1.1 attribution of a SigmaHQ rule: author, rule link and license', async () => {
    const alert = alertByTitle('SQL Injection Strings In URI');
    renderApp({ path: `/alerts/${alert.id}`, language: 'en' });
    const panel = within(
      (await screen.findByRole('heading', { name: 'Rule' })).closest('section') as HTMLElement,
    );
    expect(panel.getByText(alert.author ?? 'missing author')).toBeInTheDocument();
    expect(panel.getByRole('link', { name: /View the rule on SigmaHQ/ })).toHaveAttribute(
      'href',
      alert.ruleUrl,
    );
    expect(
      panel.getByRole('link', { name: /Detection Rule License \(DRL\) 1\.1/ }),
    ).toHaveAttribute('href', 'https://github.com/SigmaHQ/Detection-Rule-License');
  });

  it('links techniques to attack.mitre.org and lists the related events', async () => {
    const alert = alertByTitle('SSH password spraying from a single source');
    renderApp({ path: `/alerts/${alert.id}`, language: 'en' });
    // The official name appears once the ATT&CK data chunk has loaded.
    const link = (await screen.findByText('Password Spraying')).closest('a');
    expect(link).toHaveTextContent('Password Spraying T1110.003');
    expect(link).toHaveAttribute('href', 'https://attack.mitre.org/techniques/T1110/003');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const timeline = (
      await screen.findByRole('heading', { name: 'Timeline of related events' })
    ).closest('section') as HTMLElement;
    // Every linked event is reachable: expand the folded groups, then count the events.
    const user = userEvent.setup();
    for (const button of within(timeline).queryAllByRole('button', { name: /^Show the/ })) {
      await user.click(button);
    }
    expect(within(timeline).getAllByRole('link', { name: 'Open event' })).toHaveLength(
      mockDb().alertEvents.get(alert.id)?.length ?? -1,
    );
    expect(screen.getByRole('heading', { name: 'Playbook' })).toBeInTheDocument();
  });

  it('shows a not-found state for an unknown alert', async () => {
    renderApp({ path: '/alerts/01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f', language: 'en' });
    expect(await screen.findByRole('alert')).toHaveTextContent('404');
  });
});
