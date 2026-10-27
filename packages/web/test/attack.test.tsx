import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HEAT_CLASSES, heatLevel } from '../src/features/attack/heat';
import { currentSearch, renderApp } from './render';

function cell(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-technique="${id}"]`);
  if (!element) throw new Error(`no cell ${id}`);
  return element;
}

describe('ATT&CK matrix', () => {
  it('shows tactic columns with alert counts as text', async () => {
    renderApp({ path: '/attack', language: 'en' });
    const column = (await screen.findByRole('heading', { name: 'Credential Access' })).closest(
      'section',
    ) as HTMLElement;
    const bruteForce = within(column).getByText(
      (_, element) => element?.getAttribute('data-technique') === 'T1110.001',
    );
    expect(bruteForce).toHaveTextContent('Password Guessing');
    expect(bruteForce).toHaveTextContent(/[1-9]\d* alerts?/);
  });

  it('shows only techniques with alerts by default and says which tactics it hides', async () => {
    renderApp({ path: '/attack', language: 'en' });
    await screen.findByRole('heading', { name: 'Credential Access' });
    const cells = document.querySelectorAll<HTMLElement>('[data-technique]');
    expect(cells.length).toBeGreaterThan(0);
    for (const element of cells) expect(within(element).queryByText('0 alerts')).toBeNull();
    expect(screen.getByText(/without activity (is|are) hidden/)).toBeInTheDocument();
  });

  it('links a cell to the alerts list filtered by technique and time range', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/attack?range=7d', language: 'en' });
    await screen.findByRole('heading', { name: 'Credential Access' });
    const link = cell('T1110.003');
    expect(link).toHaveAttribute('href', '/alerts?range=7d&technique=T1110.003');

    await user.click(link);
    expect(router.state.location.pathname).toBe('/alerts');
    expect(currentSearch(router).get('technique')).toBe('T1110.003');
    const table = await screen.findByRole('table', { name: /Alerts, newest first/ });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
    expect(
      within(table).getByText('SSH password spraying from a single source'),
    ).toBeInTheDocument();
  });

  it('switches to rule coverage and can show every technique', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/attack', language: 'en' });
    await screen.findByRole('heading', { name: 'Credential Access' });

    await user.click(screen.getByRole('button', { name: 'Rule coverage' }));
    expect(currentSearch(router).get('view')).toBe('coverage');
    expect(cell('T1190')).toHaveTextContent(/[1-9]\d* rules?/);
    expect(cell('T1190')).toHaveAttribute('href', '/rules?technique=T1190');
    const active = document.querySelectorAll('[data-technique]');
    for (const element of active)
      expect(within(element as HTMLElement).queryByText('0 rules')).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Show all techniques' }));
    expect(currentSearch(router).get('all')).toBe('1');
    expect(document.querySelectorAll('[data-technique]').length).toBeGreaterThan(active.length);
    // Cells without rules still say so in text, for screen readers.
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-technique]')].some(
        (element) => within(element).queryByText('0 rules') !== null,
      ),
    ).toBe(true);
  });
});

describe('heat levels', () => {
  it('maps counts to five steps, zero only for no activity', () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(3, 10)).toBe(2);
    expect(heatLevel(6, 10)).toBe(3);
    expect(heatLevel(10, 10)).toBe(4);
    expect(heatLevel(50, 10)).toBe(4);
    expect(heatLevel(1, 0)).toBe(0);
    expect(HEAT_CLASSES.alerts).toHaveLength(5);
    expect(HEAT_CLASSES.coverage).toHaveLength(5);
  });
});
