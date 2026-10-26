/**
 * Parser registry (ARCHITECTURE §2.3, §4). Session S1 registers `linux_auth`,
 * `nginx_access` and `apache_access`; S5 adds `sysmon`. Until then the registry is empty
 * and the orchestrator rejects every line with `unknown source`.
 */
import type { Parser, ParserRegistry } from '../pipeline/types.js';

export function createParserRegistry(): ParserRegistry {
  const parsers: Parser[] = [];
  return new Map(parsers.map((parser) => [parser.source, parser]));
}
