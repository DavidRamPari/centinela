import type { NormalizedEvent } from '@centinela/shared';

export interface TimelineGroup {
  /** Stable React key: the id of the group's first event. */
  key: string;
  events: NormalizedEvent[];
  first: string;
  last: string;
}

/**
 * Events that read the same to an analyst: same host, action, outcome and source. The user
 * may differ, so a password spray (one source, many accounts) folds into one line.
 */
function sameKind(a: NormalizedEvent, b: NormalizedEvent): boolean {
  return (
    a.host === b.host &&
    a.action === b.action &&
    a.outcome === b.outcome &&
    (a.srcIp ?? '') === (b.srcIp ?? '')
  );
}

/** Runs shorter than this stay as separate rows: folding two lines hides more than it saves. */
export const MIN_GROUP = 3;

/**
 * Folds consecutive events of the same kind into one group, keeping the order (the API
 * returns an alert's events oldest first). "46 failed sign-ins from 203.0.113.77" reads
 * better than 46 rows; the group expands to show every line. Runs shorter than
 * `MIN_GROUP` are returned as one group per event.
 */
export function groupTimeline(
  events: readonly NormalizedEvent[],
  minGroup = MIN_GROUP,
): TimelineGroup[] {
  const runs: TimelineGroup[] = [];
  for (const event of events) {
    const current = runs[runs.length - 1];
    const previous = current?.events[current.events.length - 1];
    if (current && previous && sameKind(previous, event)) {
      current.events.push(event);
      current.last = event.ts;
    } else {
      runs.push({ key: event.id, events: [event], first: event.ts, last: event.ts });
    }
  }
  return runs.flatMap((run) =>
    run.events.length >= minGroup
      ? [run]
      : run.events.map((event) => ({
          key: event.id,
          events: [event],
          first: event.ts,
          last: event.ts,
        })),
  );
}

export type WhatKey =
  | 'signInSuccess'
  | 'signInFailure'
  | 'invalidUser'
  | 'maxAuth'
  | 'pamFailure'
  | 'disconnect'
  | 'sessionOpened'
  | 'sessionClosed'
  | 'sudoCommand'
  | 'sudoFailure'
  | 'sudoNotAllowed'
  | 'userCreated'
  | 'groupCreated'
  | 'addedToGroup'
  | 'passwordChanged'
  | 'suSuccess'
  | 'suFailure'
  | 'webRequest'
  | 'webError'
  | 'webMalformed'
  | 'processStart'
  | 'networkConnection'
  | 'fileCreate'
  | 'other';

/** Translation key (under `timeline.what.`) of what an event did. */
export function whatKey(event: Pick<NormalizedEvent, 'action' | 'outcome'>): WhatKey {
  const { action, outcome } = event;
  switch (action) {
    case 'ssh_login':
      return outcome === 'success' ? 'signInSuccess' : 'signInFailure';
    case 'ssh_invalid_user':
      return 'invalidUser';
    case 'ssh_max_auth_exceeded':
      return 'maxAuth';
    case 'ssh_pam_auth_failure':
      return 'pamFailure';
    case 'ssh_preauth_close':
    case 'ssh_disconnect':
      return 'disconnect';
    case 'session_opened':
    case 'logind_session_new':
      return 'sessionOpened';
    case 'session_closed':
    case 'logind_session_removed':
      return 'sessionClosed';
    case 'sudo_command':
      return 'sudoCommand';
    case 'sudo_auth_failure':
      return 'sudoFailure';
    case 'sudo_not_in_sudoers':
      return 'sudoNotAllowed';
    case 'user_created':
      return 'userCreated';
    case 'group_created':
      return 'groupCreated';
    case 'user_added_to_group':
      return 'addedToGroup';
    case 'password_changed':
      return 'passwordChanged';
    case 'su_session':
      return 'suSuccess';
    case 'su_failure':
      return 'suFailure';
    case 'http_request':
      return outcome === 'failure' ? 'webError' : 'webRequest';
    case 'http_malformed':
      return 'webMalformed';
    case 'process_start':
      return 'processStart';
    case 'network_connection':
      return 'networkConnection';
    case 'file_create':
      return 'fileCreate';
    default:
      return 'other';
  }
}
