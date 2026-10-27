/**
 * Parser registry (ARCHITECTURE §2.3, §4): `linux_auth`, `nginx_access`, `apache_access`
 * and `sysmon`. Sources without a parser are rejected by the orchestrator with
 * `unknown source`.
 */
import type { Parser, ParserRegistry } from '../pipeline/types.js';
import { linuxAuthParser } from './linux-auth.js';
import { sysmonParser } from './sysmon/index.js';
import { apacheAccessParser, nginxAccessParser } from './web-access.js';

export { linuxAuthLogsources } from './linux-auth.js';
export { sysmonLogsources } from './sysmon/index.js';
export { MAX_LINE_LENGTH } from './common.js';

export function createParserRegistry(): ParserRegistry {
  const parsers: Parser[] = [linuxAuthParser, nginxAccessParser, apacheAccessParser, sysmonParser];
  return new Map(parsers.map((parser) => [parser.source, parser]));
}
