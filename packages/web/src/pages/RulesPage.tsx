import { LEVELS, type RuleListItem } from '@centinela/shared';
import { CircleCheck, CircleX } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { flattenPages, useRulesList } from '../api/hooks';
import { SeverityBadge } from '../components/ui/Badges';
import { Button } from '../components/ui/Button';
import { DataTable, type Column } from '../components/ui/DataTable';
import { SelectField, TextField, ToggleChips } from '../components/ui/Fields';
import { LoadMore } from '../components/ui/LoadMore';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { readRuleFilters, ruleQueryParams, type RuleFilters } from '../features/rules/rule-filters';
import { useFormat } from '../lib/format';
import { useParamUpdater } from '../lib/search-params';

export default function RulesPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const search = params.toString();
  const filters = useMemo(() => readRuleFilters(new URLSearchParams(search)), [search]);
  const list = useRulesList(useMemo(() => ruleQueryParams(filters), [filters]));
  const rules = flattenPages(list.data);

  const columns: Array<Column<RuleListItem>> = [
    {
      id: 'title',
      header: t('rules.table.title'),
      cell: (rule) => (
        <div className="min-w-0">
          <Link
            to={`/rules/${rule.id}`}
            tabIndex={-1}
            className="font-medium text-fg hover:text-accent hover:underline"
          >
            {rule.title}
          </Link>
          <p className="hidden max-w-[28rem] truncate font-mono text-[11px] text-muted md:block">
            {rule.path}
          </p>
        </div>
      ),
    },
    {
      id: 'level',
      header: t('rules.table.level'),
      cell: (rule) => <SeverityBadge level={rule.level} />,
    },
    {
      id: 'techniques',
      header: t('rules.table.techniques'),
      cell: (rule) => (
        <span className="font-mono text-xs">{rule.techniques.join(', ') || '—'}</span>
      ),
      className: 'hidden lg:table-cell',
    },
    {
      id: 'status',
      header: t('rules.table.status'),
      cell: (rule) => rule.status ?? '—',
      className: 'hidden xl:table-cell',
    },
    {
      id: 'origin',
      header: t('rules.table.origin'),
      cell: (rule) => t(`origins.${rule.origin}`),
      className: 'hidden md:table-cell whitespace-nowrap',
    },
    {
      id: 'supported',
      header: t('rules.table.supported'),
      cell: (rule) =>
        rule.supported ? (
          <span className="inline-flex items-center gap-1 text-success">
            <CircleCheck aria-hidden="true" className="size-3.5" />
            {t('rules.supported')}
          </span>
        ) : (
          <span className="inline-flex flex-col">
            <span className="inline-flex items-center gap-1 text-danger">
              <CircleX aria-hidden="true" className="size-3.5" />
              {t('rules.unsupported')}
            </span>
            <span className="font-mono text-[11px] text-muted">{rule.unsupportedReason}</span>
          </span>
        ),
    },
    {
      id: 'enabled',
      header: t('rules.table.enabled'),
      cell: (rule) => (rule.enabled ? t('rules.enabled') : t('rules.disabled')),
      className: 'hidden sm:table-cell',
    },
    {
      id: 'matches',
      header: t('rules.table.matches'),
      cell: (rule) => format.number(rule.matches),
      className: 'text-right',
    },
  ];

  return (
    <section>
      <PageHeader title={t('pages.rules.title')} description={t('pages.rules.description')} />
      <RuleFilterBar key={`${filters.q ?? ''}|${filters.technique ?? ''}`} filters={filters} />
      {list.isPending ? (
        <LoadingState />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rules.length === 0 ? (
        <EmptyState title={t('rules.empty')} />
      ) : (
        <>
          <DataTable
            caption={t('rules.table.caption')}
            columns={columns}
            rows={rules}
            getRowId={(rule) => rule.id}
            rowLabel={(rule) => rule.title}
            onOpen={(rule) => void navigate(`/rules/${rule.id}`)}
          />
          <LoadMore
            shown={rules.length}
            hasMore={list.hasNextPage}
            loading={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
          />
        </>
      )}
    </section>
  );
}

function RuleFilterBar({ filters }: { filters: RuleFilters }) {
  const { t } = useTranslation();
  const update = useParamUpdater();
  const [q, setQ] = useState(filters.q ?? '');
  const [technique, setTechnique] = useState(filters.technique ?? '');
  const booleanOptions = (yes: string, no: string) => [
    { value: '', label: t('common.all') },
    { value: 'true', label: yes },
    { value: 'false', label: no },
  ];

  function submit(event: FormEvent) {
    event.preventDefault();
    update({ q: q.trim(), technique: technique.trim().toUpperCase() });
  }

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end gap-3">
        <ToggleChips
          label={t('rules.filters.level')}
          options={[...LEVELS].reverse().map((value) => ({ value, label: t(`levels.${value}`) }))}
          selected={filters.level}
          onChange={(level) => update({ level })}
        />
        <SelectField
          label={t('rules.filters.origin')}
          value={filters.origin ?? ''}
          onChange={(event) => update({ origin: event.target.value })}
          options={[
            { value: '', label: t('common.all') },
            { value: 'sigmahq', label: t('origins.sigmahq') },
            { value: 'centinela', label: t('origins.centinela') },
          ]}
        />
        <SelectField
          label={t('rules.filters.supported')}
          value={filters.supported ?? ''}
          onChange={(event) => update({ supported: event.target.value })}
          options={booleanOptions(t('rules.supported'), t('rules.unsupported'))}
        />
        <SelectField
          label={t('rules.filters.enabled')}
          value={filters.enabled ?? ''}
          onChange={(event) => update({ enabled: event.target.value })}
          options={booleanOptions(t('rules.enabled'), t('rules.disabled'))}
        />
      </div>
      <form
        role="search"
        aria-label={t('rules.filters.form')}
        onSubmit={submit}
        className="flex flex-wrap items-end gap-2"
      >
        <TextField
          label={t('rules.filters.q')}
          value={q}
          onChange={(event) => setQ(event.target.value)}
          maxLength={256}
          className="min-w-[14rem] flex-1"
        />
        <TextField
          label={t('rules.filters.technique')}
          value={technique}
          onChange={(event) => setTechnique(event.target.value)}
          maxLength={9}
          placeholder="T1110.001"
        />
        <Button type="submit" variant="primary">
          {t('common.search')}
        </Button>
      </form>
    </div>
  );
}
