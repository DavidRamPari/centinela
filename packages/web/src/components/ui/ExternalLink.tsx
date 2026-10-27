import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { safeHref } from '../../lib/links';

/**
 * Link that opens in a new tab; non-http(s) URLs are rendered as plain text. No arrow icon:
 * the link text says where it goes, and screen readers hear that it opens a new tab.
 */
export function ExternalLink({
  href,
  children,
}: {
  href: string | null | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const safe = safeHref(href);
  if (!safe) return <span className="break-words">{children}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className="break-words text-link underline decoration-line-strong underline-offset-3 hover:decoration-link"
    >
      {children}
      <span className="sr-only"> {t('common.newTab')}</span>
    </a>
  );
}
