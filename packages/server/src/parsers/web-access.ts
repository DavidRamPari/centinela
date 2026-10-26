/**
 * `nginx_access` and `apache_access` parsers (ARCHITECTURE §4.2): the combined log format
 *
 *   $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent
 *   "$http_referer" "$http_user_agent"
 *
 * optionally followed by a request time. Sigma webserver fields keep the raw, URL-encoded
 * text; `-` means absent. A request line that is not `METHOD SP target SP HTTP/x` (TLS
 * handshakes, scanner garbage) becomes `action: "http_malformed"`; a line that is not an
 * access-log line at all is rejected.
 */
import type { FieldValue, LogSource, SourceType } from '@centinela/shared';
import type { IngestContext, Parser, ParseResult } from '../pipeline/types.js';
import { buildEvent, normalizeIp, parseCount, reject, sanitizeLine } from './common.js';
import { parseAccessLogTime } from './time.js';

/**
 * Quoted fields allow escaped characters (`\"` from Apache, `\x22` from nginx). The
 * alternatives inside the quotes are disjoint, so matching is linear.
 */
const COMBINED =
  /^(\S+) (\S+) (\S+) \[([^\]]*)\] "((?:[^"\\]|\\.)*)" (\d{3}) (\d+|-) "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"(?: (.*))?$/;
const REQUEST_LINE = /^([A-Za-z][A-Za-z0-9_-]{0,31}) (\S+) (HTTP\/\d(?:\.\d)?)$/;
const REQUEST_TIME = /^(\d{1,9}(?:\.\d{1,9})?)(?: |$)/;

function absent(value: string | undefined): string | undefined {
  return value === undefined || value === '-' || value === '' ? undefined : value;
}

/** Best-effort decoding of a query string, for display only (`url.query_decoded`). */
export function decodeQuery(query: string): string {
  const spaced = query.replaceAll('+', ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    // Malformed escapes: decode the valid `%XX` sequences byte by byte (Latin-1).
    return spaced.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }
}

interface RequestParts {
  method: string;
  target: string;
  stem: string;
  query: string | undefined;
  version: string;
}

function parseRequestLine(request: string): RequestParts | undefined {
  const m = REQUEST_LINE.exec(request);
  if (!m) return undefined;
  const [, method = '', target = '', version = ''] = m;
  const q = target.indexOf('?');
  return {
    method,
    target,
    stem: q === -1 ? target : target.slice(0, q),
    query: q === -1 ? undefined : absent(target.slice(q + 1)),
    version,
  };
}

export function createAccessLogParser(
  source: Extract<SourceType, 'nginx_access' | 'apache_access'>,
  service: 'nginx' | 'apache',
): Parser {
  const logsources: LogSource[] = [{ category: 'webserver' }, { service }];

  function parse(raw: string, ctx: IngestContext): ParseResult {
    const line = sanitizeLine(raw);
    const m = COMBINED.exec(line);
    if (!m) return reject('not an access log line');
    const [, remoteAddr = '', , remoteUser, time = '', request = '', status = '', bytes] = m;
    const [, , , , , , , , referer, userAgent, trailer] = m;

    const ts = parseAccessLogTime(time);
    if (ts === undefined) return reject('invalid timestamp');

    const statusCode = Number(status);
    const bodyBytes = parseCount(absent(bytes));
    const user = absent(remoteUser);
    const srcIp = normalizeIp(remoteAddr);
    const req = parseRequestLine(request);
    const requestTime = trailer === undefined ? undefined : REQUEST_TIME.exec(trailer)?.[1];

    const fields: Record<string, FieldValue | undefined> = {
      'process.name': service,
      // Sigma webserver fields (raw text).
      'c-ip': remoteAddr,
      'cs-username': user,
      'cs-method': req?.method,
      'cs-uri-stem': req?.stem,
      'cs-uri-query': req?.query,
      'cs-version': req?.version,
      'sc-status': statusCode,
      'sc-bytes': bodyBytes,
      'cs-referer': absent(referer),
      'cs-user-agent': absent(userAgent),
      // ECS-style web fields.
      'http.request.method': req?.method,
      'url.path': req?.stem,
      'url.query': req?.query,
      'url.original': req?.target,
      'url.query_decoded': req?.query === undefined ? undefined : decodeQuery(req.query),
      'http.response.status_code': statusCode,
      'http.response.body.bytes': bodyBytes,
      'http.request.referrer': absent(referer),
      'user_agent.original': absent(userAgent),
      'http.version': req?.version.slice('HTTP/'.length),
      'http.request.time': requestTime === undefined ? undefined : Number(requestTime),
      'source.address': remoteAddr,
    };

    return buildEvent({
      ts,
      source,
      host: ctx.host,
      logsources,
      category: 'web',
      action: req ? 'http_request' : 'http_malformed',
      outcome: statusCode < 400 ? 'success' : 'failure',
      user,
      srcIp,
      message: line,
      fields,
    });
  }

  return { source, parse };
}

export const nginxAccessParser = createAccessLogParser('nginx_access', 'nginx');
export const apacheAccessParser = createAccessLogParser('apache_access', 'apache');
