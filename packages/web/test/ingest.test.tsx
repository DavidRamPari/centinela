import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { UPLOAD_HISTORY_KEY } from '../src/features/ingest/upload-history';
import { renderApp } from './render';
import { server } from './setup';

const AUTH_LOG = [
  '2026-10-25T14:03:12.123456-05:00 bastion-01 sshd[1234]: Failed password for root from 203.0.113.45 port 51234 ssh2',
  '2026-10-25T14:03:14.123456-05:00 bastion-01 sshd[1234]: Failed password for root from 203.0.113.45 port 51236 ssh2',
  'not a log line',
  '',
].join('\n');

describe('ingest page', () => {
  it('uploads a file through POST /api/ingest/upload and shows the summary and history', async () => {
    const user = userEvent.setup();
    const sent: Array<{ query: URLSearchParams; body: string; type: string | null }> = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/ingest/upload') {
        void request
          .clone()
          .text()
          .then((body) =>
            sent.push({ query: url.searchParams, body, type: request.headers.get('content-type') }),
          );
      }
    });
    renderApp({ path: '/ingest', language: 'en' });
    await user.upload(
      await screen.findByLabelText('Log file'),
      new File([AUTH_LOG], 'auth.log', { type: 'text/plain' }),
    );
    await user.clear(screen.getByLabelText('Time zone'));
    await user.type(screen.getByLabelText('Time zone'), 'America/Lima');
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    const summary = await screen.findByText('Upload processed');
    const box = summary.closest('[role="status"]') as HTMLElement;
    expect(within(box).getByText('Accepted: 2')).toBeInTheDocument();
    expect(within(box).getByText('Rejected: 1')).toBeInTheDocument();
    expect(within(box).getByText(/Line 3: not a syslog line/)).toBeInTheDocument();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.query.toString()).toBe('source=linux_auth&host=bastion-01&tz=America%2FLima');
    expect(sent[0]?.type).toContain('text/plain');
    expect(sent[0]?.body).toBe(AUTH_LOG);

    const history = screen
      .getByRole('heading', { name: 'Last uploads (this browser)' })
      .closest('section') as HTMLElement;
    expect(within(history).getByText('auth.log')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(UPLOAD_HISTORY_KEY) ?? '[]')).toHaveLength(1);
  });

  it('rejects files above 5 MB and invalid hosts before sending anything', async () => {
    const user = userEvent.setup();
    let requests = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/api/ingest/upload')) requests += 1;
    });
    renderApp({ path: '/ingest', language: 'en' });
    const big = new File(['x'], 'big.log', { type: 'text/plain' });
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    await user.upload(await screen.findByLabelText('Log file'), big);
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('The file is larger than 5 MB.')).toBeInTheDocument();

    await user.upload(screen.getByLabelText('Log file'), new File([AUTH_LOG], 'auth.log'));
    await user.clear(screen.getByLabelText('Host'));
    await user.type(screen.getByLabelText('Host'), 'bad host;rm');
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText(/The host may contain letters/)).toBeInTheDocument();
    expect(requests).toBe(0);
  });

  it('ignores a corrupted upload history in localStorage', async () => {
    window.localStorage.setItem(UPLOAD_HISTORY_KEY, '[{"at":"<script>"}]');
    renderApp({ path: '/ingest', language: 'en' });
    expect(await screen.findByText('No uploads yet.')).toBeInTheDocument();
  });

  it('shows a curl example with a bearer token for POST /api/ingest', async () => {
    renderApp({ path: '/ingest', language: 'en' });
    const example = await screen.findByLabelText('Send lines from a server');
    expect(example).toHaveTextContent('/api/ingest?source=linux_auth');
    expect(example).toHaveTextContent('Authorization: Bearer $INGEST_TOKEN');
  });
});
