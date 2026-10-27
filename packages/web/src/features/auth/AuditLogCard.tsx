/** Audit log, newest first, filterable by action; every value is rendered as text. */
import { AUDIT_ACTIONS, auditActionSchema, type AuditEntry } from '@centinela/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { flattenPages } from '../../api/hooks';
import { Section } from '../../components/ui/Section';
import { Truncate } from '../../components/ui/Truncate';
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable';
import { SelectField } from '../../components/ui/Fields';
import { LoadMore } from '../../components/ui/LoadMore';
import { EmptyState, ErrorState, RefreshFailed, Updating } from '../../components/ui/States';
import { useFormat } from '../../lib/format';
import { actionKey, formatDetails, targetLink } from './audit-format';
import { useAuditLog } from './hooks';

export function AuditLogCard() {
  const { t } = useTranslation();
  const format = useFormat();
  const [action, setAction] = useState('');
  const audit = useAuditLog({ action });
  const entries = flattenPages(audit.data);

  // Fixed widths for the short columns; the details take what is left (S6 known gap).
  const columns: Array<Column<AuditEntry>> = [
    {
      id: 'at',
      header: t('auth.audit.at'),
      cell: (entry) => (
        <time dateTime={entry.at} title={format.dateTime(entry.at)}>
          {format.eventTime(entry.at)}
        </time>
      ),
      className: 'w-44 whitespace-nowrap',
    },
    {
      id: 'actor',
      header: t('auth.audit.actor'),
      cell: (entry) => <Truncate text={entry.actor ?? t('common.none')} className="max-w-[9rem]" />,
      className: 'w-36',
    },
    {
      id: 'action',
      header: t('auth.audit.action'),
      cell: (entry) => t(`auth.audit.actions.${actionKey(entry.action)}`),
      className: 'w-48',
    },
    {
      id: 'target',
      header: t('auth.audit.target'),
      cell: (entry) => {
        const href = targetLink(entry);
        const text = (
          <Truncate text={entry.target ?? t('common.none')} mono className="max-w-[13rem]" />
        );
        return href ? (
          <Link
            to={href}
            className="block text-link underline decoration-transparent underline-offset-3 hover:decoration-link"
          >
            {text}
          </Link>
        ) : (
          text
        );
      },
      className: 'hidden @3xl:table-cell w-56',
    },
    {
      id: 'ip',
      header: t('auth.audit.ip'),
      cell: (entry) => <span className="whitespace-nowrap">{entry.ip ?? t('common.none')}</span>,
      className: 'hidden @2xl:table-cell w-36',
    },
    {
      id: 'details',
      header: t('auth.audit.details'),
      cell: (entry) => <Truncate text={formatDetails(entry.details) || t('common.none')} mono />,
      className: 'hidden @5xl:table-cell w-full max-w-0',
    },
  ];

  return (
    <Section
      title={t('auth.audit.title')}
      description={t('auth.audit.description')}
      divider
      actions={
        <SelectField
          label={t('auth.audit.filter')}
          value={action}
          onChange={(event) => {
            const parsed = auditActionSchema.safeParse(event.target.value);
            setAction(parsed.success ? parsed.data : '');
          }}
          options={[
            { value: '', label: t('common.all') },
            ...AUDIT_ACTIONS.map((value) => ({
              value,
              label: t(`auth.audit.actions.${actionKey(value)}`),
            })),
          ]}
        />
      }
    >
      {audit.data === undefined ? (
        audit.isError ? (
          <ErrorState error={audit.error} onRetry={() => audit.refetch()} />
        ) : (
          <TableSkeleton columns={columns} rows={5} label={t('auth.audit.loading')} />
        )
      ) : (
        <>
          {audit.isRefetchError ? (
            <RefreshFailed error={audit.error} onRetry={() => audit.refetch()} />
          ) : null}
          <Updating active={audit.isPlaceholderData}>
            {entries.length === 0 ? (
              <EmptyState title={t('auth.audit.empty')} description={t('auth.audit.emptyHint')} />
            ) : (
              <>
                <DataTable
                  caption={t('auth.audit.title')}
                  columns={columns}
                  rows={entries}
                  getRowId={(entry) => entry.id}
                  rowLabel={(entry) => `${entry.action} ${entry.actor ?? ''}`}
                />
                <LoadMore
                  hasMore={audit.hasNextPage}
                  loading={audit.isFetchingNextPage}
                  failed={audit.isFetchNextPageError}
                  onLoadMore={() => void audit.fetchNextPage({ cancelRefetch: false })}
                  shown={entries.length}
                />
              </>
            )}
          </Updating>
        </>
      )}
    </Section>
  );
}
