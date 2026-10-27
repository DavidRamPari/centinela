/**
 * Pure presentation helpers of the S7b redesign: timeline folding, user names, trends,
 * axis widths, urgency order and the drawn brand letters.
 */
import type { Alert, NormalizedEvent } from '@centinela/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { CorridorNumber } from '../src/components/brand/CorridorNumber';
import { DIGITS, LETTERS, MARKS, layout } from '../src/components/brand/corridor';
import { Mark } from '../src/components/brand/Mark';
import { displayUser, primaryEntity, userDomains } from '../src/features/alerts/entities';
import { groupTimeline, whatKey } from '../src/features/alerts/timeline/group';
import { Timeline } from '../src/features/alerts/timeline/Timeline';
import { yAxisWidth } from '../src/features/overview/axis';
import { byUrgency } from '../src/features/overview/urgency';
import { createI18n } from '../src/i18n';
import { levelWeight } from '../src/lib/levels';
import { previousPeriod, trend } from '../src/lib/time-range';

let seq = 0;
function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  seq += 1;
  return {
    id: `01930f6e-8a4b-7c2d-9e1f-${String(seq).padStart(12, '0')}`,
    ts: new Date(Date.UTC(2026, 9, 26, 8, 18, seq)).toISOString(),
    ingestedAt: '2026-10-26T09:00:00.000Z',
    source: 'linux_auth',
    host: 'bastion-01',
    logsources: [{ product: 'linux', service: 'sshd' }],
    category: 'authentication',
    action: 'ssh_login',
    outcome: 'failure',
    user: 'deploy',
    srcIp: '203.0.113.77',
    message: `Failed password for deploy from 203.0.113.77 port ${String(40000 + seq)} ssh2`,
    fields: {},
    ...overrides,
  };
}

function alert(overrides: Partial<Alert>): Alert {
  return {
    id: '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f',
    ruleId: 'r',
    ruleTitle: 'Rule',
    ruleType: 'sigma',
    level: 'medium',
    status: 'new',
    resolution: null,
    note: null,
    dedupKey: 'k',
    groupKey: null,
    host: 'web-01',
    techniques: [],
    tactics: [],
    entities: { ips: [], users: [], hosts: [] },
    firstSeen: '2026-10-26T08:00:00.000Z',
    lastSeen: '2026-10-26T08:00:00.000Z',
    count: 1,
    author: null,
    ruleUrl: null,
    license: null,
    createdAt: '2026-10-26T08:00:00.000Z',
    updatedAt: '2026-10-26T08:00:00.000Z',
    ...overrides,
  };
}

describe('timeline folding', () => {
  it('folds consecutive events of the same kind and keeps the order', () => {
    const failures = Array.from({ length: 4 }, () => event({}));
    const success = event({ outcome: 'success', message: 'Accepted password for deploy' });
    const groups = groupTimeline([...failures, success]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.events).toEqual(failures);
    expect(groups[0]?.first).toBe(failures[0]?.ts);
    expect(groups[0]?.last).toBe(failures[3]?.ts);
    expect(groups[1]?.events).toEqual([success]);
  });

  it('keeps short runs as separate rows', () => {
    const groups = groupTimeline([event({}), event({}), event({ srcIp: '198.51.100.23' })]);
    expect(groups.map((group) => group.events.length)).toEqual([1, 1, 1]);
  });

  it('folds a password spray: one source, many users', () => {
    const spray = ['root', 'admin', 'oracle', 'test'].map((user) => event({ user }));
    expect(groupTimeline(spray)).toHaveLength(1);
  });

  it('does not fold across a different host, action, outcome or source', () => {
    const base = Array.from({ length: 3 }, () => event({}));
    for (const change of [
      { host: 'web-01' },
      { action: 'ssh_invalid_user' },
      { outcome: 'success' as const },
      { srcIp: undefined },
    ]) {
      const groups = groupTimeline([...base, event(change), ...base]);
      expect(groups.map((group) => group.events.length)).toEqual([3, 1, 3]);
    }
  });

  it('names what an event did, with a fallback for unknown actions', () => {
    expect(whatKey({ action: 'ssh_login', outcome: 'failure' })).toBe('signInFailure');
    expect(whatKey({ action: 'ssh_login', outcome: 'success' })).toBe('signInSuccess');
    expect(whatKey({ action: 'http_request', outcome: 'failure' })).toBe('webError');
    expect(whatKey({ action: 'process_start', outcome: 'unknown' })).toBe('processStart');
    expect(whatKey({ action: 'something_new', outcome: 'unknown' })).toBe('other');
  });

  it('renders a folded group as one sentence that expands to every line', async () => {
    const user = userEvent.setup();
    const failures = Array.from({ length: 12 }, () => event({}));
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <MemoryRouter>
          <Timeline events={[...failures, event({ outcome: 'success' })]} />
        </MemoryRouter>
      </I18nextProvider>,
    );
    expect(screen.getByText('12 failed sign-ins from 203.0.113.77 as deploy')).toBeInTheDocument();
    expect(screen.getByText(/^between .+ and .+$/)).toBeInTheDocument();
    expect(screen.getByText('Successful sign-in from 203.0.113.77 as deploy')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open event' })).toHaveLength(1);

    const toggle = screen.getByRole('button', { name: 'Show the 12 events' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide the 12 events' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getAllByRole('link', { name: 'Open event' })).toHaveLength(13);
  });

  it('counts the users of a spray instead of naming one', () => {
    render(
      <I18nextProvider i18n={createI18n('es')}>
        <MemoryRouter>
          <Timeline events={['root', 'admin', 'oracle'].map((user) => event({ user }))} />
        </MemoryRouter>
      </I18nextProvider>,
    );
    expect(
      screen.getByText('3 inicios de sesión fallidos desde 203.0.113.77 para 3 usuarios'),
    ).toBeInTheDocument();
  });
});

describe('user names', () => {
  it('shows Windows users as DOMAIN\\name and others as the bare name', () => {
    expect(displayUser({ user: 'm.condori', fields: { 'user.domain': 'ANDES' } })).toBe(
      'ANDES\\m.condori',
    );
    expect(displayUser({ user: 'deploy', fields: {} })).toBe('deploy');
    expect(displayUser({ user: 'x', fields: { 'user.domain': '' } })).toBe('x');
    expect(displayUser({ user: undefined, fields: { 'user.domain': 'ANDES' } })).toBeUndefined();
  });

  it('maps alert users to their domain from the linked events', () => {
    const names = userDomains([
      event({ user: 'm.condori', fields: { 'user.domain': 'ANDES' } }),
      event({ user: 'deploy' }),
    ]);
    expect(names.get('m.condori')).toBe('ANDES\\m.condori');
    expect(names.get('deploy')).toBe('deploy');
  });

  it('picks a user before an IP to name who is behind an alert', () => {
    expect(
      primaryEntity(alert({ entities: { ips: ['1.2.3.4'], users: ['ana'], hosts: [] } })),
    ).toBe('ana');
    expect(primaryEntity(alert({ entities: { ips: ['1.2.3.4'], users: [], hosts: [] } }))).toBe(
      '1.2.3.4',
    );
  });
});

describe('overview helpers', () => {
  it('compares with the period of the same length right before', () => {
    expect(
      previousPeriod({ from: '2026-10-26T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' }),
    ).toEqual({
      from: '2026-10-25T00:00:00.000Z',
      to: '2026-10-26T00:00:00.000Z',
    });
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    expect(previousPeriod({ from: '2026-10-27T11:00:00.000Z' }, now)).toEqual({
      from: '2026-10-27T10:00:00.000Z',
      to: '2026-10-27T11:00:00.000Z',
    });
  });

  it('describes a trend, and refuses to compare with nothing', () => {
    expect(trend(112, 100)).toEqual({ kind: 'up', percent: 12, difference: 12 });
    expect(trend(93, 100)).toEqual({ kind: 'down', percent: 7, difference: 7 });
    expect(trend(5, 5)).toEqual({ kind: 'same' });
    expect(trend(5, 0)).toEqual({ kind: 'none' });
  });

  it('sizes the y axis for its longest label', () => {
    expect(yAxisWidth(['6,000'])).toBeGreaterThanOrEqual(5 * 7);
    expect(yAxisWidth(['64,213'])).toBeGreaterThan(yAxisWidth(['12']));
    expect(yAxisWidth([])).toBeGreaterThan(0);
  });

  it('orders alerts most severe first, then newest first', () => {
    const older = alert({ id: 'a', level: 'high', lastSeen: '2026-10-26T08:00:00.000Z' });
    const newer = alert({ id: 'b', level: 'high', lastSeen: '2026-10-26T09:00:00.000Z' });
    const critical = alert({ id: 'c', level: 'critical', lastSeen: '2026-10-25T08:00:00.000Z' });
    const low = alert({ id: 'd', level: 'low', lastSeen: '2026-10-27T08:00:00.000Z' });
    expect(byUrgency([older, low, newer, critical]).map((a) => a.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(levelWeight('informational')).toBe(1);
    expect(levelWeight('critical')).toBe(5);
  });
});

describe('brand', () => {
  it('draws every character a formatted number can contain', () => {
    for (const char of '0123456789') expect(DIGITS[char]).toBeDefined();
    expect(MARKS[',']).toBeDefined();
    expect(MARKS['.']).toBeDefined();
    for (const char of 'centinela') expect(LETTERS[char]).toBeDefined();
    expect(LETTERS.i?.dot).toBeDefined();
  });

  it('lays out glyphs with tracking and gives unknown characters a gap', () => {
    const { items, width } = layout('10', DIGITS);
    expect(items.map((item) => item.x)).toEqual([0, 4.9]);
    expect(width).toBe(8.9);
    expect(layout('1 0', DIGITS).items).toHaveLength(3);
  });

  it('keeps a drawn number readable as text', () => {
    const { container } = render(<CorridorNumber text="64,213" />);
    expect(screen.getByText('64,213')).toHaveClass('sr-only');
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the mark in colour or in one colour', () => {
    const { container, rerender } = render(<Mark title="Centinela" />);
    expect(screen.getByRole('img', { name: 'Centinela' })).toBeInTheDocument();
    expect(container.querySelectorAll('path, rect')).toHaveLength(3);
    rerender(<Mark mono />);
    for (const shape of container.querySelectorAll('path, rect')) {
      expect(shape).toHaveAttribute('fill', 'currentColor');
    }
  });
});
