import { normalizedEventSchema, type NormalizedEvent } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import {
  apacheAccessParser,
  decodeQuery,
  nginxAccessParser,
} from '../../src/parsers/web-access.js';
import type { IngestContext } from '../../src/pipeline/types.js';

const ctx: IngestContext = {
  source: 'nginx_access',
  host: 'web-01',
  receivedAt: new Date('2026-10-26T12:00:00Z'),
  timezone: 'UTC',
};

type Event = Omit<NormalizedEvent, 'id' | 'ingestedAt'>;

function parse(line: string, parser = nginxAccessParser): Event {
  const result = parser.parse(line, { ...ctx, source: parser.source });
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  normalizedEventSchema.parse({
    ...result.event,
    id: '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f',
    ingestedAt: '2026-10-26T12:00:00.000Z',
  });
  return result.event;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0';
const line = (request: string, status = 200, extra = '') =>
  `198.18.4.20 - - [25/Oct/2026:14:03:12 -0500] "${request}" ${status} 5120 "https://shop.example/" "${UA}"${extra}`;

describe('web access parsers (combined format)', () => {
  it('maps a request to Sigma webserver and ECS fields', () => {
    const event = parse(line('GET /products/zapatillas?color=rojo&talla=42 HTTP/1.1'));
    expect(event).toMatchObject({
      ts: '2026-10-25T19:03:12.000Z',
      source: 'nginx_access',
      host: 'web-01',
      category: 'web',
      action: 'http_request',
      outcome: 'success',
      srcIp: '198.18.4.20',
      logsources: [{ category: 'webserver' }, { service: 'nginx' }],
    });
    expect(event.fields).toMatchObject({
      'c-ip': '198.18.4.20',
      'cs-method': 'GET',
      'cs-uri-stem': '/products/zapatillas',
      'cs-uri-query': 'color=rojo&talla=42',
      'cs-version': 'HTTP/1.1',
      'sc-status': 200,
      'sc-bytes': 5120,
      'cs-referer': 'https://shop.example/',
      'cs-user-agent': UA,
      'http.request.method': 'GET',
      'url.path': '/products/zapatillas',
      'url.query': 'color=rojo&talla=42',
      'url.original': '/products/zapatillas?color=rojo&talla=42',
      'http.response.status_code': 200,
      'http.response.body.bytes': 5120,
      'http.request.referrer': 'https://shop.example/',
      'user_agent.original': UA,
      'http.version': '1.1',
      'event.action': 'http_request',
      'event.outcome': 'success',
      'event.category': 'web',
      'host.name': 'web-01',
      'source.ip': '198.18.4.20',
    });
    expect(event.fields['cs-username']).toBeUndefined();
  });

  it('routes Apache lines to the apache logsource', () => {
    const event = parse(line('GET / HTTP/1.0'), apacheAccessParser);
    expect(event.source).toBe('apache_access');
    expect(event.logsources).toEqual([{ category: 'webserver' }, { service: 'apache' }]);
    expect(event.fields['process.name']).toBe('apache');
  });

  it('keeps the query URL-encoded in Sigma fields and decodes a display copy', () => {
    const event = parse(
      line('GET /download?file=..%252f..%252fetc%252fpasswd&q=caf%C3%A9+con+leche HTTP/1.1'),
    );
    expect(event.fields['cs-uri-query']).toBe(
      'file=..%252f..%252fetc%252fpasswd&q=caf%C3%A9+con+leche',
    );
    expect(event.fields['url.query_decoded']).toBe('file=..%2f..%2fetc%2fpasswd&q=café con leche');
  });

  it('omits the query field for a bare "?"', () => {
    const event = parse(line('GET /search? HTTP/1.1'));
    expect(event.fields['cs-uri-stem']).toBe('/search');
    expect(event.fields['cs-uri-query']).toBeUndefined();
  });

  it('marks status >= 400 as failure', () => {
    expect(parse(line('GET /x HTTP/1.1', 404)).outcome).toBe('failure');
    expect(parse(line('GET /x HTTP/1.1', 399)).outcome).toBe('success');
    expect(parse(line('GET /x HTTP/1.1', 500)).outcome).toBe('failure');
  });

  it('reads the remote user and treats "-" as absent', () => {
    const event = parse(
      '10.20.0.5 - analyst [25/Oct/2026:14:03:12 +0000] "GET /admin HTTP/1.1" 200 - "-" "-"',
    );
    expect(event.user).toBe('analyst');
    expect(event.fields).toMatchObject({ 'cs-username': 'analyst', 'user.name': 'analyst' });
    expect(event.fields['sc-bytes']).toBeUndefined();
    expect(event.fields['cs-referer']).toBeUndefined();
    expect(event.fields['cs-user-agent']).toBeUndefined();
  });

  it('reads an optional trailing request time', () => {
    expect(parse(line('GET / HTTP/1.1', 200, ' 0.123')).fields['http.request.time']).toBe(0.123);
    expect(parse(line('GET / HTTP/1.1', 200, ' 1534 extra')).fields['http.request.time']).toBe(
      1534,
    );
    expect(parse(line('GET / HTTP/1.1')).fields['http.request.time']).toBeUndefined();
  });

  it('accepts IPv6 clients', () => {
    const event = parse(
      '2001:DB8::25 - - [25/Oct/2026:14:03:12 -0500] "GET / HTTP/2.0" 200 10 "-" "curl/8.5.0"',
    );
    expect(event.srcIp).toBe('2001:db8::25');
    expect(event.fields['c-ip']).toBe('2001:DB8::25');
    expect(event.fields['cs-version']).toBe('HTTP/2.0');
  });

  it('keeps a host name client in c-ip without source.ip', () => {
    const event = parse(
      'client.example - - [25/Oct/2026:14:03:12 -0500] "GET / HTTP/1.1" 200 10 "-" "-"',
    );
    expect(event.srcIp).toBeUndefined();
    expect(event.fields['c-ip']).toBe('client.example');
  });

  it('handles escaped quotes inside quoted fields (Apache \\" and nginx \\x22)', () => {
    const apache = parse(
      '192.0.2.10 - - [25/Oct/2026:14:03:12 -0500] "GET /a HTTP/1.1" 200 1 "-" "Mozilla \\"quoted\\""',
    );
    expect(apache.fields['cs-user-agent']).toBe('Mozilla \\"quoted\\"');
    const nginx = parse(
      '192.0.2.10 - - [25/Oct/2026:14:03:12 -0500] "GET /a?x=\\x22 HTTP/1.1" 200 1 "-" "-"',
    );
    expect(nginx.fields['cs-uri-query']).toBe('x=\\x22');
  });

  it.each([
    ['a TLS handshake', '\\x16\\x03\\x01\\x00\\xA5\\x01'],
    ['an empty request', '-'],
    ['a request without version', 'GET /'],
    ['a request with spaces in the target', 'GET /a b HTTP/1.1'],
    ['garbage', 'SSH-2.0-Go'],
  ])('keeps %s as http_malformed', (_name, request) => {
    const event = parse(line(request, 400));
    expect(event.action).toBe('http_malformed');
    expect(event.fields['cs-method']).toBeUndefined();
    expect(event.fields['sc-status']).toBe(400);
    expect(event.message).toContain(request);
  });

  it.each([
    ['an empty line', ''],
    ['a syslog line', 'Oct 25 14:03:12 web-01 nginx[1]: started'],
    [
      'a common-log line without referer and user agent',
      '1.2.3.4 - - [25/Oct/2026:14:03:12 -0500] "GET / HTTP/1.1" 200 1',
    ],
    [
      'a line with a non-numeric status',
      '1.2.3.4 - - [25/Oct/2026:14:03:12 -0500] "GET / HTTP/1.1" OK 1 "-" "-"',
    ],
  ])('rejects %s as not an access log line', (_name, text) => {
    expect(nginxAccessParser.parse(text, ctx)).toEqual({
      ok: false,
      reason: 'not an access log line',
    });
  });

  it.each([
    ['an unknown month', '1.2.3.4 - - [25/Foo/2026:14:03:12 -0500] "GET / HTTP/1.1" 200 1 "-" "-"'],
    [
      'an impossible date',
      '1.2.3.4 - - [31/Feb/2026:14:03:12 -0500] "GET / HTTP/1.1" 200 1 "-" "-"',
    ],
    ['a malformed time', '1.2.3.4 - - [yesterday] "GET / HTTP/1.1" 200 1 "-" "-"'],
  ])('rejects %s as an invalid timestamp', (_name, text) => {
    expect(nginxAccessParser.parse(text, ctx)).toEqual({ ok: false, reason: 'invalid timestamp' });
  });

  it('truncates very long lines and fields to 8,192 characters', () => {
    const long = line(`GET /search?q=${'A'.repeat(30_000)} HTTP/1.1`);
    const event = parse(long);
    expect(event.message).toHaveLength(8192);
    expect(String(event.fields['cs-uri-query'])).toHaveLength(8192);
    expect(event.fields['sc-status']).toBe(200);
  });

  it('rejects a pathological line quickly', () => {
    const hostile = `1.2.3.4 - - [25/Oct/2026:14:03:12 -0500] "${'\\"'.repeat(30_000)}`;
    const started = performance.now();
    expect(nginxAccessParser.parse(hostile, ctx).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('keeps hostile content as inert text', () => {
    const event = parse(line(`GET /?q=<script>alert(1)</script>&id=1'%20OR%201=1-- HTTP/1.1`));
    expect(event.fields['cs-uri-query']).toBe("q=<script>alert(1)</script>&id=1'%20OR%201=1--");
  });
});

describe('decodeQuery', () => {
  it('decodes percent escapes and plus signs', () => {
    expect(decodeQuery('a=1%202+3')).toBe('a=1 2 3');
  });

  it('falls back to byte-wise decoding for malformed escapes', () => {
    expect(decodeQuery('a=%E0%A4%A&b=%41')).toBe('a=à¤%A&b=A');
  });
});
