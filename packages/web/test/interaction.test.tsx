/**
 * Interaction quality (docs/decisions/S7b.md, S7b-17): skeletons only before the first
 * answer, data kept on screen while it refreshes, errors that say what to do, one submit
 * at a time, optimistic triage with rollback, the live highlight and the copy buttons.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRESH_ALERT_MS } from '../src/features/live/live-context';
import { MOCK_PASSWORD, MOCK_USERNAME } from '../src/features/auth/mocks';
import { mockDb } from '../src/mocks/handlers';
import { createFakeLiveSource } from './live-fake';
import { renderApp } from './render';
import { server } from './setup';

afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
});

/** A promise the test opens when it wants a mocked request to go on. */
function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Holds every request to `path` (any method) until the gate opens, then lets it through. */
function hold(method: 'get' | 'post' | 'patch', path: string) {
  const g = gate();
  // A resolver that returns nothing hands the request on to the default mock handler.
  server.use(
    http[method](path, async () => {
      await g.promise;
    }),
  );
  return g;
}

function problem(status: number, title: string, detail: string) {
  return HttpResponse.json(
    { type: 'about:blank', title, status, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

/** Counts the requests to `path` with `method`. */
function countRequests(method: string, path: string) {
  const counter = { count: 0 };
  server.events.on('request:start', ({ request }) => {
    if (request.method === method && new URL(request.url).pathname === path) counter.count += 1;
  });
  return counter;
}

function alertByTitle(title: string) {
  const alert = mockDb().alerts.find((a) => a.ruleTitle === title);
  if (!alert) throw new Error(`no fixture alert ${title}`);
  return alert;
}

const skeleton = () => document.querySelector('[data-skeleton]');

describe('loading: skeletons first, then data', () => {
  it('draws the alerts table with real headers and placeholder rows, then the rows', async () => {
    const pending = hold('get', '/api/alerts');
    renderApp({ path: '/alerts', language: 'en' });
    expect(await screen.findByText('Loading alerts…')).toBeInTheDocument();
    const placeholder = skeleton();
    expect(placeholder).toHaveAttribute('aria-busy', 'true');
    const skeletonHeaders = [...(placeholder?.querySelectorAll('th') ?? [])].map((th) => [
      th.textContent,
      th.className,
    ]);
    expect(skeletonHeaders.length).toBeGreaterThan(5);
    // Its header controls (select all) cannot be reached until the rows arrive.
    expect(placeholder?.querySelector('table')).toHaveAttribute('inert');

    pending.open();
    const table = await screen.findByRole('table', { name: /Alerts, newest first/ });
    expect(skeleton()).toBeNull();
    // The placeholder had the same columns, with the same classes: nothing moves.
    const headers = [...table.querySelectorAll('th')].map((th) => [th.textContent, th.className]);
    expect(headers.map(([, className]) => className)).toEqual(
      skeletonHeaders.map(([, className]) => className),
    );
  });

  it.each([
    {
      name: 'overview',
      path: '/',
      request: '/api/stats/overview',
      label: 'Loading the overview…',
    },
    { name: 'events', path: '/events', request: '/api/events', label: 'Loading events…' },
    {
      name: 'ATT&CK',
      path: '/attack',
      request: '/api/attack',
      label: 'Loading the ATT&CK matrix…',
    },
    { name: 'rules', path: '/rules', request: '/api/rules', label: 'Loading rules…' },
  ])('replaces the $name skeleton with the data', async ({ path, request, label }) => {
    const pending = hold('get', request);
    renderApp({ path, language: 'en' });
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(skeleton()).not.toBeNull();
    pending.open();
    await waitFor(() => expect(screen.queryByText(label)).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('draws the alert page with its headings while the alert loads', async () => {
    const alert = alertByTitle('Cross Site Scripting Strings');
    const pending = hold('get', '/api/alerts/:id');
    renderApp({ path: `/alerts/${alert.id}`, language: 'en' });
    expect(await screen.findByText('Loading the alert…')).toBeInTheDocument();
    expect(screen.getByText('What happened')).toBeInTheDocument();
    expect(screen.getByText('Triage')).toBeInTheDocument();
    pending.open();
    expect(
      await screen.findByRole('heading', { level: 1, name: alert.ruleTitle }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading the alert…')).not.toBeInTheDocument();
  });
});

describe('loading: a refresh never replaces the data with a skeleton', () => {
  it('keeps the rows on screen during a background refetch', async () => {
    const { queryClient } = renderApp({ path: '/alerts', language: 'en' });
    const table = await screen.findByRole('table', { name: /Alerts, newest first/ });
    const pending = hold('get', '/api/alerts');
    let refetch: Promise<void> | undefined;
    act(() => {
      refetch = queryClient.invalidateQueries({ queryKey: ['alerts'] });
    });
    await waitFor(() => expect(queryClient.isFetching({ queryKey: ['alerts'] })).toBe(1));
    expect(table).toBeInTheDocument();
    expect(skeleton()).toBeNull();
    pending.open();
    await act(() => refetch);
    expect(screen.getByRole('table', { name: /Alerts, newest first/ })).toBe(table);
  });

  it('keeps the previous rows, marked busy, while a new filter loads', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/alerts', language: 'en' });
    const table = await screen.findByRole('table', { name: /Alerts, newest first/ });
    const pending = hold('get', '/api/alerts');
    await user.click(screen.getByRole('button', { name: 'Critical' }));
    const updating = table.closest('[data-updating]');
    expect(updating).toHaveAttribute('aria-busy', 'true');
    expect(skeleton()).toBeNull();
    pending.open();
    await waitFor(() => expect(document.querySelector('[data-updating]')).toBeNull());
  });

  it('keeps the data and says so when a refresh fails', async () => {
    const { queryClient } = renderApp({ path: '/alerts', language: 'en' });
    await screen.findByRole('table', { name: /Alerts, newest first/ });
    server.use(http.get('/api/alerts', () => problem(500, 'Internal Server Error', 'boom')));
    await act(() => queryClient.invalidateQueries({ queryKey: ['alerts'] }));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('Could not refresh; showing the last data loaded.');
    expect(notice).toHaveTextContent('try again in a moment');
    expect(screen.getByRole('table', { name: /Alerts, newest first/ })).toBeInTheDocument();
  });
});

describe('errors say what to do and offer a retry', () => {
  it('explains a server error and loads the data on retry', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/alerts', () => problem(503, 'Service Unavailable', 'database down'), {
        once: true,
      }),
    );
    renderApp({ path: '/alerts', language: 'en' });
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('The server ran into a problem');
    expect(error).toHaveTextContent('If it keeps failing, check the server logs.');
    expect(error).toHaveTextContent('503: database down');
    await user.click(within(error).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: /Alerts, newest first/ })).toBeInTheDocument();
  });

  it('tells the analyst to check the connection when the server cannot be reached', async () => {
    server.use(http.get('/api/attack', () => HttpResponse.error()));
    renderApp({ path: '/attack', language: 'es' });
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('No se puede contactar con el servidor');
    expect(error).toHaveTextContent('Comprueba tu conexión');
  });
});

describe('one submit at a time', () => {
  it('signs in once when the form is submitted twice in a row', async () => {
    const user = userEvent.setup();
    const logins = countRequests('POST', '/api/auth/login');
    renderApp({ path: '/login', language: 'en', auth: 'signed-out' });
    await user.type(await screen.findByLabelText('User name'), MOCK_USERNAME);
    await user.type(screen.getByLabelText('Password'), MOCK_PASSWORD);
    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form') as HTMLFormElement;
    // Both submits land before React re-renders: only the guard can stop the second.
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(screen.getByRole('button', { name: 'Signing in…' })).toHaveAttribute('aria-busy');
    await waitFor(() => expect(screen.queryByLabelText('Password')).not.toBeInTheDocument());
    expect(logins.count).toBe(1);
  });

  it('uploads once, and is busy while it reads the file', async () => {
    const user = userEvent.setup();
    const uploads = countRequests('POST', '/api/ingest/upload');
    renderApp({ path: '/ingest', language: 'en' });
    await user.upload(
      await screen.findByLabelText('Log file'),
      new File(['not a log line\n'], 'auth.log', { type: 'text/plain' }),
    );
    const button = screen.getByRole('button', { name: 'Upload' });
    act(() => {
      fireEvent.submit(button.closest('form') as HTMLFormElement);
      fireEvent.submit(button.closest('form') as HTMLFormElement);
    });
    expect(button).toBeDisabled();
    expect(await screen.findByText('Upload processed')).toBeInTheDocument();
    expect(uploads.count).toBe(1);
  });

  it('sends one status change for a double click on Acknowledge', async () => {
    const alert = alertByTitle('Cross Site Scripting Strings');
    const patches = countRequests('PATCH', `/api/alerts/${alert.id}`);
    renderApp({ path: `/alerts/${alert.id}`, language: 'en' });
    const button = await screen.findByRole('button', { name: 'Acknowledge' });
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(alert.status).toBe('acknowledged'));
    expect(await screen.findByText('Alert updated')).toBeInTheDocument();
    expect(patches.count).toBe(1);
  });
});

describe('optimistic triage', () => {
  it('shows the new status at once and rolls back with a message when the server refuses', async () => {
    const user = userEvent.setup();
    const alert = alertByTitle('Cross Site Scripting Strings');
    const g = gate();
    server.use(
      http.patch('/api/alerts/:id', async () => {
        await g.promise;
        return problem(500, 'Internal Server Error', 'database unavailable');
      }),
    );
    renderApp({ path: `/alerts/${alert.id}`, language: 'en' });
    const heading = await screen.findByRole('heading', { level: 1, name: alert.ruleTitle });
    const header = heading.closest('header') as HTMLElement;
    expect(header.querySelector('[data-status]')).toHaveAttribute('data-status', 'new');

    await user.type(screen.getByLabelText('Note'), 'Checked the WAF logs');
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    // At once, before the server answers.
    expect(header.querySelector('[data-status]')).toHaveAttribute('data-status', 'acknowledged');
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close alert' })).toBeDisabled();

    g.open();
    const message = await screen.findByRole('alert');
    expect(message).toHaveTextContent('The alert could not be updated.');
    expect(message).toHaveTextContent('back to its previous status (New)');
    expect(header.querySelector('[data-status]')).toHaveAttribute('data-status', 'new');
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
    // The typed note survives the rollback; the server never changed.
    expect(screen.getByLabelText('Note')).toHaveValue('Checked the WAF logs');
    expect(alert.status).toBe('new');
  });

  it('acknowledges selected rows at once and puts them back if the bulk change fails', async () => {
    const user = userEvent.setup();
    const g = gate();
    server.use(
      http.post('/api/alerts/bulk', async () => {
        await g.promise;
        return problem(500, 'Internal Server Error', 'database unavailable');
      }),
    );
    renderApp({ path: '/alerts', language: 'en' });
    const table = await screen.findByRole('table', { name: /Alerts, newest first/ });
    const titles = ['Cross Site Scripting Strings', 'JNDIExploit Pattern'];
    for (const title of titles) {
      await user.click(within(table).getByRole('checkbox', { name: `Select alert ${title}` }));
    }
    await user.click(screen.getByRole('button', { name: 'Acknowledge selected' }));
    expect(screen.getByText('Saving the change…')).toBeInTheDocument();
    const row = (title: string) =>
      within(table).getByRole('row', { name: new RegExp(`: ${title}$`) });
    for (const title of titles) {
      expect(row(title).querySelector('[data-status]')).toHaveAttribute(
        'data-status',
        'acknowledged',
      );
    }

    g.open();
    const toast = await screen.findByRole('alert');
    expect(toast).toHaveTextContent('The alerts could not be updated.');
    expect(toast).toHaveTextContent('back to their previous status');
    for (const title of titles) {
      expect(row(title).querySelector('[data-status]')).toHaveAttribute('data-status', 'new');
      expect(alertByTitle(title).status).toBe('new');
    }
  });
});

describe('live highlight', () => {
  it('tints a new live alert in the list for a moment, then fades it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const live = createFakeLiveSource();
    renderApp({ path: '/alerts', language: 'en', liveSource: live.source });
    const table = await screen.findByRole('table', { name: /Alerts, newest first/ });
    act(() => live.open());
    const template = alertByTitle('SSH brute force followed by a successful login');
    const now = new Date().toISOString();
    const alert = {
      ...template,
      id: '019a1b2c-3d4e-7f00-8a00-0000000000ab',
      status: 'new' as const,
      resolution: null,
      firstSeen: now,
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
      ruleTitle: 'Live alert to highlight',
    };
    mockDb().alerts.unshift(alert);
    act(() => live.emit('alert.created', alert));

    const row = await within(table).findByRole('row', { name: /Live alert to highlight/ });
    expect(row).toHaveAttribute('data-fresh', 'true');
    act(() => {
      vi.advanceTimersByTime(FRESH_ALERT_MS);
    });
    await waitFor(() => expect(row).not.toHaveAttribute('data-fresh'));
  });
});

describe('copy buttons', () => {
  /** The confirmation slot beside a copy button: in the flow, never on top of the page. */
  function statusOf(button: HTMLElement) {
    const slot = button.parentElement?.querySelector('[data-copy-status]');
    if (!(slot instanceof HTMLElement)) throw new Error('no confirmation slot');
    return { slot, live: within(slot).getByRole('status') };
  }

  it('copies an IP address and confirms it beside the button for a moment', async () => {
    const user = userEvent.setup();
    const alert = alertByTitle('SSH password spraying from a single source');
    const ip = alert.entities.ips[0] ?? 'missing ip';
    renderApp({ path: `/alerts/${alert.id}`, language: 'en' });
    const button = await screen.findByRole('button', { name: `Copy ${ip}` });
    const { slot, live } = statusOf(button);
    // The slot always holds the width of its longest message, so showing one moves nothing.
    expect(slot).toHaveTextContent('CopiedNot copied');
    expect(live).toHaveTextContent('');
    await user.click(button);
    expect(await navigator.clipboard.readText()).toBe(ip);
    await waitFor(() => expect(live).toHaveTextContent('Copied'));
    await waitFor(() => expect(live).toHaveTextContent(''), { timeout: 3000 });
  });

  it('says so when the browser refuses to copy', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    const alert = alertByTitle('SSH password spraying from a single source');
    renderApp({ path: `/alerts/${alert.id}`, language: 'en' });
    const button = await screen.findByRole('button', { name: `Copy ${alert.id}` });
    await user.click(button);
    await waitFor(() => expect(statusOf(button).live).toHaveTextContent('Not copied'));
  });

  it('turns a labelled copy button into "Copied" in place, keeping its name', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/ingest', language: 'en' });
    const button = await screen.findByRole('button', { name: 'Copy' });
    await user.click(button);
    expect(await navigator.clipboard.readText()).toContain('curl -X POST');
    await waitFor(() =>
      expect(within(button.parentElement as HTMLElement).getByRole('status')).toHaveTextContent(
        'Copied',
      ),
    );
    expect(button).toHaveAccessibleName('Copy');
  });
});
