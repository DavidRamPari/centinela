import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { LANGUAGE_STORAGE_KEY } from '../src/i18n';
import { THEME_STORAGE_KEY, initialTheme } from '../src/lib/theme';
import { renderApp } from './render';
import { server } from './setup';

const pages = [
  { link: 'Overview', heading: 'Overview', path: '/' },
  { link: 'Alerts', heading: 'Alerts', path: '/alerts' },
  { link: 'Events', heading: 'Events', path: '/events' },
  { link: 'ATT&CK', heading: 'ATT&CK matrix', path: '/attack' },
  { link: 'Rules', heading: 'Rules', path: '/rules' },
  { link: 'Ingest', heading: 'Ingest', path: '/ingest' },
];

describe('app shell', () => {
  it('navigates between every page from the sidebar', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ language: 'en' });
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    for (const page of [...pages].reverse()) {
      await user.click(within(nav).getByRole('link', { name: page.link }));
      expect(
        await screen.findByRole('heading', { level: 1, name: page.heading }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe(page.path);
      expect(within(nav).getByRole('link', { name: page.link })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
  });

  it('switches to Spanish, persists the choice and keeps navigation working', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/alerts', language: 'en' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Alerts' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'es' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Alertas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'es' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es');
    expect(document.documentElement.lang).toBe('es');

    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });
    await user.click(within(nav).getByRole('link', { name: 'Reglas' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Reglas' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'en' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeInTheDocument();
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
  });

  it('starts in the stored language', async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es');
    renderApp();
    expect(await screen.findByRole('heading', { level: 1, name: 'Resumen' })).toBeInTheDocument();
  });

  it('formats numbers and dates in the selected language', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/alerts', language: 'en' });
    expect((await screen.findAllByText(/^[A-Z][a-z]{2} \d{1,2}, /)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'es' }));
    expect((await screen.findAllByText(/^\d{1,2} [a-z]{3}/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('columnheader', { name: 'Última vez' })).toBeInTheDocument();
  });

  it('switches between the dark and light themes and remembers the choice', async () => {
    const user = userEvent.setup();
    renderApp({ language: 'en' });
    expect(document.documentElement).toHaveClass('dark');
    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(initialTheme()).toBe('dark');
  });

  it('shows a not-found page for unknown paths', () => {
    renderApp({ path: '/nope', language: 'en' });
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
  });

  it('shows API health from GET /api/health', async () => {
    renderApp({ language: 'en' });
    expect(await screen.findByText('API online')).toBeInTheDocument();
  });

  it('shows a degraded database as text, not only color', async () => {
    server.use(
      http.get('/api/health', () =>
        HttpResponse.json({ status: 'degraded', db: 'down', version: '0.1.0' }, { status: 503 }),
      ),
    );
    renderApp({ language: 'en' });
    expect(await screen.findByText('Database unreachable')).toBeInTheDocument();
  });
});
