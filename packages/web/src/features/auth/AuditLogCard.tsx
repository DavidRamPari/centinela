/** Audit log, newest first, filterable by action; every value is rendered as text. */
import { AUDIT_ACTIONS, auditActionSchema, type AuditEntry } from '@centinela/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { flattenPages } from '../../api/hooks';
import { Card } from '../../components/ui/Card';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { SelectField } from '../../components/ui/Fields';
import { LoadMore } from '../../components/ui/LoadMore';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { useFormat } from '../../lib/format';
import { actionKey, formatDetails, targetLink } from './audit-format';
import { useAuditLog } from './hooks';

export function AuditLogCard() {
  const { t } = useTranslation();
  const format = useFormat();
  const [action, setAction] = useState('');
  const audit = useAuditLog({ action });
  const entries = flattenPages(audit.data);

  const columns: Array<Column<AuditEntry>> = [
    {
      id: 'at',
      header: t('auth.audit.at'),
      cell: (entry) => <time dateTime={entry.at}>{format.dateTime(entry.at)}</time>,
      className: 'whitespace-nowrap',
    },
    {
      id: 'actor',
      header: t('auth.audit.actor'),
      cell: (entry) => (
        <span className="inline-block min-w-20 font-mono text-xs wrap-anywhere">
          {entry.actor ?? '—'}
        </span>
      ),
    },
    {
      id: 'action',
      header: t('auth.audit.action'),
      cell: (entry) => t(`auth.audit.actions.${actionKey(entry.action)}`),
    },
    {
      id: 'target',
      header: t('auth.audit.target'),
      cell: (entry) => {
        const href = targetLink(entry);
        const text = <span className="font-mono text-xs wrap-anywhere">{entry.target ?? '—'}</span>;
        return href ? (
          <Link to={href} className="text-accent underline">
            {text}
          </Link>
        ) : (
          text
        );
      },
    },
    {
      id: 'ip',
      header: t('auth.audit.ip'),
      cell: (entry) => <span className="font-mono text-xs">{entry.ip ?? '—'}</span>,
    },
    {
      id: 'details',
      header: t('auth.audit.details'),
      cell: (entry) => (
        <span className="line-clamp-2 max-w-[24rem] font-mono text-xs wrap-anywhere">
          {formatDetails(entry.details)}
        </span>
      ),
    },
  ];

  return (
    <Card
      title={t('auth.audit.title')}
      className="xl:col-span-2"
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
      <p className="mb-3 text-muted">{t('auth.audit.description')}</p>
      {audit.isPending ? (
        <LoadingState />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState title={t('auth.audit.empty')} />
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
            onLoadMore={() => void audit.fetchNextPage()}
            shown={entries.length}
          />
        </>
      )}
    </Card>
  );
}
