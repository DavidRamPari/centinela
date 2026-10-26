import { useTranslation } from 'react-i18next';
import { useFormat } from '../../lib/format';
import { Button } from './Button';

/** Keyset pagination control: the next page is fetched with the server's cursor. */
export function LoadMore({
  hasMore,
  loading,
  onLoadMore,
  shown,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  shown: number;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-3 text-xs text-muted">
      <span>{t('common.shown', { value: format.number(shown) })}</span>
      {hasMore ? (
        <Button size="sm" onClick={onLoadMore} disabled={loading}>
          {loading ? t('common.loading') : t('common.loadMore')}
        </Button>
      ) : (
        <span>{t('common.endOfList')}</span>
      )}
    </div>
  );
}
