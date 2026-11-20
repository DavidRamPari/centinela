/**
 * What a scoped ingest token may send (ARCHITECTURE §9, S11): its source types and its
 * hosts. An empty list allows everything. A host entry is a lower-cased host name, or the
 * start of one followed by `*`; hosts compare without regard to ASCII case. Patterns are
 * compared as text here and are never compiled as a regex.
 */
export interface TokenScope {
  readonly sources: readonly string[];
  readonly hosts: readonly string[];
}

/** A to Z lower-cased, everything else kept: `İ` never stands for `i`. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

export function allowsSource(scope: TokenScope, source: string): boolean {
  return scope.sources.length === 0 || scope.sources.includes(source);
}

export function hostMatches(pattern: string, host: string): boolean {
  const name = asciiLower(host);
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

export function allowsHost(scope: TokenScope, host: string): boolean {
  return scope.hosts.length === 0 || scope.hosts.some((pattern) => hostMatches(pattern, host));
}
