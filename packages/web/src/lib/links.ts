/** Links built from data (rule references, rule URLs): only http(s) URLs become hrefs. */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** attack.mitre.org page of a technique id (`T1110.001` → `/techniques/T1110/001/`). */
export function techniqueUrl(id: string): string {
  return `https://attack.mitre.org/techniques/${id.toUpperCase().replace('.', '/')}/`;
}

export const DRL_URL = 'https://github.com/SigmaHQ/Detection-Rule-License';
