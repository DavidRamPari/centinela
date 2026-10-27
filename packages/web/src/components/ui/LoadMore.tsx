import { useTranslation } from 'react-i18next';
import { useFormat } from '../../lib/format';
import { Button } from './Button';

/**
 * Keyset pagination control: the next page is fetched with the server's cursor. A failed
 * page says so next to the button, which then offers to try again.
 */
export function LoadMore({
  hasMore,
  loading,
  failed = false,
  onLoadMore,
  shown,
}: {
  hasMore: boolean;
  loading: boolean;
  /** The last attempt to load the next page failed. */
  failed?: boolean;
  onLoadMore: () => void;
  shown: number;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-4 text-muted">
      <span>{t('common.shown', { value: format.number(shown) })}</span>
      {hasMore ? (
        <span className="flex flex-wrap items-center gap-3">
          {failed && !loading ? (
            <span role="alert" className="font-semibold text-danger">
              {t('common.loadMoreFailed')}
            </span>
          ) : null}
          <Button size="sm" onClick={onLoadMore} loading={loading}>
            {loading ? t('common.loading') : failed ? t('common.retry') : t('common.loadMore')}
          </Button>
        </span>
      ) : (
        <span>{t('common.endOfList')}</span>
      )}
    </div>
  );
}
