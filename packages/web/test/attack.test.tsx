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
    expect(bruteForce).toHaveTextContent(/Alerts: [1-9]/);
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

  it('switches to rule coverage and can hide techniques without activity', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/attack', language: 'en' });
    await screen.findByRole('heading', { name: 'Credential Access' });
    const total = document.querySelectorAll('[data-technique]').length;

    await user.click(screen.getByRole('button', { name: 'Rule coverage' }));
    expect(currentSearch(router).get('view')).toBe('coverage');
    expect(cell('T1190')).toHaveTextContent(/Rules: [1-9]/);
    expect(cell('T1190')).toHaveAttribute('href', '/rules?technique=T1190');

    await user.click(screen.getByRole('checkbox', { name: 'Only techniques with activity' }));
    expect(currentSearch(router).get('active')).toBe('1');
    const shown = document.querySelectorAll('[data-technique]');
    expect(shown.length).toBeLessThan(total);
    for (const element of shown) expect(element).not.toHaveTextContent('Rules: 0');
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
    expect(HEAT_CLASSES).toHaveLength(5);
  });
});
