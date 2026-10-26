import { ExternalLink as ExternalIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { safeHref } from '../../lib/links';

/** Link that opens in a new tab; non-http(s) URLs are rendered as plain text. */
export function ExternalLink({
  href,
  children,
}: {
  href: string | null | undefined;
  children: ReactNode;
}) {
  const safe = safeHref(href);
  if (!safe) return <span className="break-all">{children}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 break-all text-accent underline-offset-2 hover:underline"
    >
      {children}
      <ExternalIcon aria-hidden="true" className="size-3 shrink-0" />
    </a>
  );
}
