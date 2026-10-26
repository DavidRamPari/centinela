import type { RuleMeta } from '@centinela/shared';
import { ArrowLeft, Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { z } from 'zod';
import { useRule, useUpdateRule } from '../api/hooks';
import { SeverityBadge } from '../components/ui/Badges';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { CodeBlock } from '../components/ui/CodeBlock';
import { DescriptionList } from '../components/ui/DescriptionList';
import { ExternalLink } from '../components/ui/ExternalLink';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { useToasts } from '../components/ui/toast-context';
import { LicenseValue } from '../features/alerts/RulePanel';
import { PlaybookPanel } from '../features/alerts/playbook/PlaybookPanel';
import { TacticNames, TechniqueLink } from '../features/attack/TechniqueLink';

const ruleIdSchema = z.guid();

export default function RuleDetailPage() {
  const { t } = useTranslation();
  const params = useParams();
  const id = ruleIdSchema.safeParse(params.id);
  if (!id.success) {
    return (
      <section>
        <BackLink />
        <EmptyState title={t('ruleDetail.notFound')} />
      </section>
    );
  }
  return <RuleDetail id={id.data} />;
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link to="/rules" className="mb-3 inline-flex items-center gap-1 text-accent hover:underline">
      <ArrowLeft aria-hidden="true" className="size-4" />
      {t('ruleDetail.back')}
    </Link>
  );
}

function RuleDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const detail = useRule(id);
  if (detail.isPending) return <LoadingState />;
  if (detail.isError) {
    return (
      <section>
        <BackLink />
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </section>
    );
  }
  const { rule, source } = detail.data;
  return (
    <section>
      <BackLink />
      <PageHeader
        title={rule.title}
        description={rule.description ?? undefined}
        actions={<SeverityBadge level={rule.level} />}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <Card title={t('ruleDetail.source')}>
            <CodeBlock text={source} label={t('ruleDetail.source')} />
          </Card>
          <PlaybookPanel ruleId={rule.id} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <EnablePanel rule={rule} />
          <MetadataCard rule={rule} />
        </div>
      </div>
    </section>
  );
}

function EnablePanel({ rule }: { rule: RuleMeta }) {
  const { t } = useTranslation();
  const { push } = useToasts();
  const update = useUpdateRule(rule.id);
  return (
    <Card title={t('ruleDetail.state')}>
      <div className="flex flex-col gap-3">
        <p>
          {rule.supported ? t('rules.supported') : t('rules.unsupported')}
          {rule.unsupportedReason ? (
            <span className="ml-2 font-mono text-xs text-muted">{rule.unsupportedReason}</span>
          ) : null}
        </p>
        {rule.buildingBlock ? <p className="text-muted">{t('ruleDetail.buildingBlock')}</p> : null}
        <p>{rule.enabled ? t('rules.enabled') : t('rules.disabled')}</p>
        <Button
          disabled={update.isPending}
          onClick={() =>
            update.mutate(
              { enabled: !rule.enabled },
              {
                onSuccess: (next) =>
                  push({
                    title: next.enabled
                      ? t('ruleDetail.enabledToast')
                      : t('ruleDetail.disabledToast'),
                  }),
                onError: () => push({ title: t('ruleDetail.updateFailed') }),
              },
            )
          }
        >
          <Power aria-hidden="true" className="size-4" />
          {rule.enabled ? t('ruleDetail.disable') : t('ruleDetail.enable')}
        </Button>
        <Link
          to={`/alerts?${new URLSearchParams({ ruleId: rule.id, range: '30d' }).toString()}`}
          className="text-accent hover:underline"
        >
          {t('ruleDetail.viewAlerts')}
        </Link>
      </div>
    </Card>
  );
}

function MetadataCard({ rule }: { rule: RuleMeta }) {
  const { t } = useTranslation();
  const logsource = rule.logsource
    ? Object.entries(rule.logsource)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ')
    : '—';
  return (
    <Card title={t('ruleDetail.metadata')}>
      <div className="flex flex-col gap-3">
        <DescriptionList
          items={[
            {
              term: t('rules.fields.id'),
              value: <span className="break-all font-mono text-xs">{rule.id}</span>,
            },
            {
              term: t('rules.fields.name'),
              value: <span className="font-mono text-xs">{rule.name ?? '—'}</span>,
            },
            { term: t('rules.fields.type'), value: t(`ruleTypes.${rule.type}`) },
            { term: t('rules.table.status'), value: rule.status ?? '—' },
            { term: t('rules.table.origin'), value: t(`origins.${rule.origin}`) },
            { term: t('rules.fields.author'), value: rule.author ?? '—' },
            {
              term: t('rules.fields.link'),
              value: rule.url ? (
                <ExternalLink href={rule.url}>{t('rules.viewSource')}</ExternalLink>
              ) : (
                <span className="text-muted">{t('rules.noLink')}</span>
              ),
            },
            { term: t('rules.fields.license'), value: <LicenseValue license={rule.license} /> },
            {
              term: t('rules.fields.path'),
              value: <span className="break-all font-mono text-xs">{rule.path}</span>,
            },
            {
              term: t('rules.fields.logsource'),
              value: <span className="font-mono text-xs">{logsource}</span>,
            },
            {
              term: t('rules.fields.date'),
              value: [rule.date, rule.modified].filter(Boolean).join(' · ') || '—',
            },
          ]}
        />
        <div>
          <h3 className="text-xs font-medium text-muted">{t('rules.table.techniques')}</h3>
          {rule.techniques.length === 0 ? (
            <p className="text-muted">—</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {rule.techniques.map((technique) => (
                <li key={technique}>
                  <TechniqueLink id={technique} />
                </li>
              ))}
            </ul>
          )}
          {rule.tactics.length > 0 ? (
            <p className="mt-1 text-xs">
              <span className="text-muted">{t('alertDetail.tactics')}: </span>
              <TacticNames tactics={rule.tactics} />
            </p>
          ) : null}
        </div>
        {rule.falsepositives.length > 0 ? (
          <div>
            <h3 className="text-xs font-medium text-muted">{t('rules.fields.falsepositives')}</h3>
            <ul className="ml-4 list-disc">
              {rule.falsepositives.map((fp) => (
                <li key={fp}>{fp}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {rule.references.length > 0 ? (
          <div>
            <h3 className="text-xs font-medium text-muted">{t('rules.fields.references')}</h3>
            <ul className="flex flex-col gap-1">
              {rule.references.map((reference) => (
                <li key={reference} className="text-xs">
                  <ExternalLink href={reference}>{reference}</ExternalLink>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
