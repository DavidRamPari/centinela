/**
 * The `events` table stores no `logsources` (S1-06): they are a pure function of the
 * source and, for some sources, a field. This module rebuilds them when events are read
 * back, following ARCHITECTURE §4.
 */
import type { FieldValue, LogSource, SourceType } from '@centinela/shared';
import { linuxAuthLogsources } from '../parsers/index.js';

/** Sysmon actions (ARCHITECTURE §4.4) and their Sigma categories. */
const SYSMON_CATEGORIES: Readonly<Record<string, string>> = {
  process_start: 'process_creation',
  network_connection: 'network_connection',
  file_create: 'file_event',
};

export function logsourcesFor(
  source: SourceType,
  action: string,
  fields: Readonly<Record<string, FieldValue>>,
): LogSource[] {
  switch (source) {
    case 'linux_auth': {
      const program = fields['process.name'];
      return linuxAuthLogsources(typeof program === 'string' ? program : undefined);
    }
    case 'nginx_access':
      return [{ category: 'webserver' }, { service: 'nginx' }];
    case 'apache_access':
      return [{ category: 'webserver' }, { service: 'apache' }];
    case 'sysmon': {
      const category = SYSMON_CATEGORIES[action];
      return [category === undefined ? { product: 'windows' } : { product: 'windows', category }];
    }
  }
}
