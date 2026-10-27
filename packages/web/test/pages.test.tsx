import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mockDb } from '../src/mocks/handlers';
import { renderApp } from './render';

let consoleError: MockInstance;
let consoleWarn: MockInstance;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error');
  consoleWarn = vi.spyOn(console, 'warn');
});
afterEach(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

interface PageCase {
  name: string;
  path: () => string;
  heading: string | RegExp;
  ready: () => Promise<unknown>;
}

const cases: PageCase[] = [
  {
    name: 'overview',
    path: () => '/',
    heading: 'Overview',
    ready: () => screen.findByRole('heading', { name: 'Needs your attention' }),
  },
  {
    name: 'alerts',
    path: () => '/alerts',
    heading: 'Alerts',
    ready: () => screen.findByRole('table', { name: /Alerts, newest first/ }),
  },
  {
    name: 'alert detail',
    path: () => `/alerts/${mockDb().alerts[0]?.id ?? ''}`,
    heading: /./,
    ready: () => screen.findByRole('heading', { name: 'Timeline of related events' }),
  },
  {
    name: 'events',
    path: () => '/events',
    heading: 'Events',
    ready: () => screen.findByRole('table', { name: /Events, newest first/ }),
  },
  {
    name: 'event drawer',
    path: () => `/events?event=${mockDb().events[0]?.id ?? ''}`,
    heading: 'Events',
    ready: () => screen.findByRole('heading', { name: 'Raw message' }),
  },
  {
    name: 'attack',
    path: () => '/attack',
    heading: 'ATT&CK matrix',
    ready: () => screen.findByRole('heading', { name: 'Credential Access' }),
  },
  {
    name: 'rules',
    path: () => '/rules',
    heading: 'Rules',
    ready: () => screen.findByRole('table', { name: 'Detection rules' }),
  },
  {
    name: 'rule detail',
    path: () => `/rules/${mockDb().rules[0]?.id ?? ''}`,
    heading: /./,
    ready: () => screen.findByRole('heading', { name: 'YAML source' }),
  },
  {
    name: 'ingest',
    path: () => '/ingest',
    heading: 'Ingest',
    ready: () => screen.findByRole('heading', { name: 'Upload a log file' }),
  },
];

describe('every page renders with mocks', () => {
  it.each(cases)('$name renders data without console errors or warnings', async (page) => {
    renderApp({ path: page.path(), language: 'en' });
    expect(
      await screen.findByRole('heading', { level: 1, name: page.heading }),
    ).toBeInTheDocument();
    await page.ready();
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});
