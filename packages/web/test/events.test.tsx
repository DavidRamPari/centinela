import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { mockDb } from '../src/mocks/handlers';
import { currentSearch, renderApp } from './render';
import { server } from './setup';

async function eventRows() {
  const table = await screen.findByRole('table', { name: /Events, newest first/ });
  return within(table).getAllByRole('row').slice(1);
}

/** Query strings of every GET /api/events the page sends. */
function recordEventRequests(): URLSearchParams[] {
  const seen: URLSearchParams[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/events') seen.push(url.searchParams);
  });
  return seen;
}

describe('events page', () => {
  it('reads its filters from the URL and sends them to the API', async () => {
    const requests = recordEventRequests();
    renderApp({
      path: '/events?host=db-01&outcome=failure&source=linux_auth&range=7d',
      language: 'en',
    });
    const rows = await eventRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toHaveTextContent('db-01');

    expect(screen.getByLabelText('Host')).toHaveValue('db-01');
    expect(screen.getByLabelText('Outcome')).toHaveValue('failure');
    expect(screen.getByLabelText('Source')).toHaveValue('linux_auth');
    expect(screen.getByLabelText('Time range')).toHaveValue('7d');
    const last = requests.at(-1);
    expect(last?.get('host')).toBe('db-01');
    expect(last?.get('outcome')).toBe('failure');
    expect(last?.get('source')).toBe('linux_auth');
    expect(Date.now() - Date.parse(last?.get('from') ?? '')).toBeGreaterThan(6.9 * 24 * 3600_000);
  });

  it('writes filter changes to the URL', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/events', language: 'en' });
    await eventRows();
    await user.selectOptions(screen.getByLabelText('Outcome'), 'failure');
    expect(currentSearch(router).get('outcome')).toBe('failure');
    await user.type(screen.getByLabelText('Source IP'), '203.0.113.45');
    await user.type(screen.getByLabelText('Text in the message'), 'Failed password');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(currentSearch(router).get('ip')).toBe('203.0.113.45');
    expect(currentSearch(router).get('q')).toBe('Failed password');
    await waitFor(async () => {
      const rows = await eventRows();
      expect(rows).toHaveLength(12);
      for (const row of rows) expect(row).toHaveTextContent('203.0.113.45');
    });
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(router.state.location.search).toBe('');
  });

  it('pages through results with the keyset cursor', async () => {
    const user = userEvent.setup();
    const requests = recordEventRequests();
    renderApp({ path: '/events', language: 'en' });
    expect(await eventRows()).toHaveLength(50);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(async () => expect(await eventRows()).toHaveLength(100));
    expect(requests.at(-1)?.get('cursor')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('opens the drawer from the keyboard, traps focus and closes with Escape', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/events', language: 'en' });
    const rows = await eventRows();
    rows[0]?.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: 'Event detail' });
    const id = rows[1]?.getAttribute('data-row-id') ?? '';
    expect(currentSearch(router).get('event')).toBe(id);
    expect(await within(dialog).findByText(id)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();

    // Tab cycles inside the dialog.
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(currentSearch(router).get('event')).toBeNull();
    expect(rows[1]).toHaveFocus();
  });

  it('opens one event from a link and shows its raw message and fields', async () => {
    const event = mockDb().events.find((e) => e.action === 'sudo_not_in_sudoers');
    renderApp({ path: `/events?event=${event?.id ?? ''}`, language: 'en' });
    const dialog = await screen.findByRole('dialog', { name: 'Event detail' });
    expect(await within(dialog).findByText(event?.message ?? 'missing')).toBeInTheDocument();
    expect(within(dialog).getByText('sudo.command')).toBeInTheDocument();
  });

  it('shows an error state when the API fails, with a retry', async () => {
    server.use(http.get('/api/events', () => new Response('boom', { status: 500 })));
    renderApp({ path: '/events', language: 'en' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('500');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    renderApp({ path: '/events?q=nothing-matches-this', language: 'en' });
    expect(await screen.findByText('No events')).toBeInTheDocument();
  });
});
