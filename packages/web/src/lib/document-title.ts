/**
 * The browser tab names the page and the product, in the selected language (S7b-18):
 * "Alerts · Centinela", or the rule title for an alert. Pages pass their own heading,
 * which is already translated, so a language switch renames the tab too.
 */
import { useEffect } from 'react';

export const PRODUCT_NAME = 'Centinela';

export function documentTitle(page?: string): string {
  return page ? `${page} · ${PRODUCT_NAME}` : PRODUCT_NAME;
}

export function useDocumentTitle(page?: string): void {
  useEffect(() => {
    document.title = documentTitle(page);
  }, [page]);
}
