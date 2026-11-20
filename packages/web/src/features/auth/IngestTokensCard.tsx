/**
 * Ingest tokens: create one (its secret is shown once, with a copy button), list them and
 * revoke them. Revoking asks for a second click instead of a browser dialog. A token may
 * be limited to some sources and hosts (S11); left empty, it may send anything.
 */
import {
  MAX_TOKEN_LABEL_LENGTH,
  SOURCE_TYPES,
  ingestTokenCreateBodySchema,
  type IngestToken,
  type IngestTokenCreated,
  type SourceType,
} from '@centinela/shared';
import { KeyRound, Plus } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { CopyTextButton } from '../../components/ui/CopyButton';
import { Section } from '../../components/ui/Section';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable';
import { Checkbox, TextField } from '../../components/ui/Fields';
import { EmptyState, ErrorState, RefreshFailed } from '../../components/ui/States';
import { useFormat } from '../../lib/format';
import { useSingleFlight } from '../../lib/single-flight';
import { useCreateToken, useRevokeToken, useTokens } from './hooks';

export function IngestTokensCard() {
  const { t } = useTranslation();
  const tokens = useTokens();
  const [created, setCreated] = useState<IngestTokenCreated | null>(null);

  return (
    <Section framed title={t('auth.tokens.title')} description={t('auth.tokens.description')}>
      <CreateTokenForm onCreated={setCreated} />
      {created ? <NewSecret created={created} onDismiss={() => setCreated(null)} /> : null}
      <div>
        {tokens.data === undefined ? (
          tokens.isError ? (
            <ErrorState error={tokens.error} onRetry={() => tokens.refetch()} />
          ) : (
            <TokensTable tokens={undefined} />
          )
        ) : (
          <>
            {tokens.isRefetchError ? (
              <RefreshFailed error={tokens.error} onRetry={() => tokens.refetch()} />
            ) : null}
            {tokens.data.items.length === 0 ? (
              <EmptyState
                compact
                icon={KeyRound}
                title={t('auth.tokens.empty')}
                description={t('auth.tokens.emptyHint')}
              />
            ) : (
              <TokensTable tokens={tokens.data.items} />
            )}
          </>
        )}
      </div>
    </Section>
  );
}

function CreateTokenForm({ onCreated }: { onCreated: (created: IngestTokenCreated) => void }) {
  const { t } = useTranslation();
  const create = useCreateToken();
  const flight = useSingleFlight();
  const [label, setLabel] = useState('');
  const [sources, setSources] = useState<SourceType[]>([]);
  const [hosts, setHosts] = useState('');
  const [invalid, setInvalid] = useState<'label' | 'hosts' | null>(null);
  const hintId = useId();
  const sourcesHintId = useId();
  const hostsHintId = useId();

  function toggleSource(source: SourceType, checked: boolean) {
    setSources((current) =>
      checked ? [...current, source] : current.filter((value) => value !== source),
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const hostList = hosts.split(/[\s,]+/).filter((host) => host !== '');
    const body = ingestTokenCreateBodySchema.safeParse({ label, sources, hosts: hostList });
    if (!body.success) {
      const onLabel = body.error.issues.some((issue) => issue.path[0] === 'label');
      setInvalid(onLabel ? 'label' : 'hosts');
      return;
    }
    setInvalid(null);
    const value = body.data;
    flight.run(() =>
      create.mutateAsync(value, {
        onSuccess: (result) => {
          setLabel('');
          setSources([]);
          setHosts('');
          onCreated(result);
        },
      }),
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" noValidate>
      <TextField
        label={t('auth.tokens.label')}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        maxLength={MAX_TOKEN_LABEL_LENGTH}
        spellCheck={false}
        className="max-w-xl"
        aria-describedby={hintId}
        aria-invalid={invalid === 'label' || undefined}
      />
      <p id={hintId} className="text-small text-muted">
        {t('auth.tokens.labelHint')}
      </p>
      <fieldset className="mt-2 flex flex-col gap-2" aria-describedby={sourcesHintId}>
        <legend className="mb-1 font-semibold text-fg">{t('auth.tokens.sources')}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {SOURCE_TYPES.map((source) => (
            <Checkbox
              key={source}
              label={t(`sources.${source}`)}
              checked={sources.includes(source)}
              onChange={(event) => toggleSource(source, event.target.checked)}
            />
          ))}
        </div>
        <p id={sourcesHintId} className="text-small text-muted">
          {t('auth.tokens.sourcesHint')}
        </p>
      </fieldset>
      <TextField
        label={t('auth.tokens.hosts')}
        value={hosts}
        onChange={(event) => setHosts(event.target.value)}
        spellCheck={false}
        autoCapitalize="none"
        className="mt-2 max-w-xl"
        aria-describedby={hostsHintId}
        aria-invalid={invalid === 'hosts' || undefined}
      />
      <p id={hostsHintId} className="text-small text-muted">
        {t('auth.tokens.hostsHint')}
      </p>
      {invalid === null ? null : (
        <p role="alert" className="font-semibold text-danger">
          {invalid === 'label' ? t('auth.tokens.labelInvalid') : t('auth.tokens.hostsInvalid')}
        </p>
      )}
      <div className="mt-1">
        <Button type="submit" variant="primary" icon={Plus} loading={flight.busy}>
          {flight.busy ? t('auth.tokens.creating') : t('auth.tokens.create')}
        </Button>
      </div>
      {create.isError ? <ErrorState error={create.error} /> : null}
    </form>
  );
}

function NewSecret({ created, onDismiss }: { created: IngestTokenCreated; onDismiss: () => void }) {
  const { t } = useTranslation();

  return (
    <div role="status" className="flex flex-col gap-3 border-l-2 border-accent-edge py-1 pl-4">
      <p className="flex items-center gap-2 font-semibold text-fg">
        <KeyRound aria-hidden="true" strokeWidth={1.75} className="size-5 text-accent-text" />
        {t('auth.tokens.createdTitle', { label: created.token.label })}
      </p>
      <p className="text-muted">{t('auth.tokens.createdWarning')}</p>
      <CodeBlock text={created.secret} label={t('auth.tokens.secret')} />
      <div className="flex gap-2">
        <CopyTextButton
          size="sm"
          variant="primary"
          value={created.secret}
          label={t('auth.tokens.copy')}
        />
        <Button size="sm" variant="quiet" onClick={onDismiss}>
          {t('auth.tokens.dismiss')}
        </Button>
      </div>
    </div>
  );
}

/** The tokens, or (while they load) the same table with placeholder rows. */
function TokensTable({ tokens }: { tokens: IngestToken[] | undefined }) {
  const { t } = useTranslation();
  const format = useFormat();
  const columns: Array<Column<IngestToken>> = [
    { id: 'label', header: t('auth.tokens.label'), cell: (token) => token.label },
    {
      id: 'prefix',
      header: t('auth.tokens.prefix'),
      cell: (token) => <span className="font-mono text-small">{token.prefix}…</span>,
    },
    {
      id: 'scope',
      header: t('auth.tokens.scope'),
      cell: (token) => (
        <span className="text-small">
          {token.sources.length === 0
            ? t('auth.tokens.anySource')
            : token.sources.map((source) => t(`sources.${source}`)).join(', ')}
          {' · '}
          {token.hosts.length === 0 ? (
            t('auth.tokens.anyHost')
          ) : (
            <span className="font-mono">{token.hosts.join(', ')}</span>
          )}
        </span>
      ),
    },
    {
      id: 'created',
      header: t('auth.tokens.createdAt'),
      cell: (token) => <time dateTime={token.createdAt}>{format.dateTime(token.createdAt)}</time>,
    },
    {
      id: 'used',
      header: t('auth.tokens.lastUsed'),
      cell: (token) =>
        token.lastUsedAt ? (
          <time dateTime={token.lastUsedAt}>{format.dateTime(token.lastUsedAt)}</time>
        ) : (
          <span className="text-muted">{t('auth.tokens.never')}</span>
        ),
    },
    {
      id: 'status',
      header: t('auth.tokens.status'),
      cell: (token) =>
        token.revokedAt ? (
          <span className="text-muted">
            {t('auth.tokens.revokedOn', { date: format.dateTime(token.revokedAt) })}
          </span>
        ) : (
          <span className="text-fg">{t('auth.tokens.active')}</span>
        ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('auth.tokens.actions')}</span>,
      cell: (token) => (token.revokedAt ? null : <RevokeButton token={token} />),
    },
  ];
  if (tokens === undefined) {
    return <TableSkeleton columns={columns} rows={3} label={t('auth.tokens.loading')} />;
  }
  return (
    <DataTable
      caption={t('auth.tokens.title')}
      columns={columns}
      rows={tokens}
      getRowId={(token) => token.id}
      rowLabel={(token) => token.label}
    />
  );
}

function RevokeButton({ token }: { token: IngestToken }) {
  const { t } = useTranslation();
  const revoke = useRevokeToken();
  const flight = useSingleFlight();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
        {t('auth.tokens.revoke')}
      </Button>
    );
  }
  return (
    <span className="flex gap-1">
      <Button
        size="sm"
        variant="danger"
        loading={flight.busy}
        aria-label={t('auth.tokens.confirmRevokeLabel', { label: token.label })}
        onClick={() =>
          flight.run(() => revoke.mutateAsync(token.id, { onSettled: () => setConfirming(false) }))
        }
      >
        {t('auth.tokens.confirmRevoke')}
      </Button>
      <Button size="sm" variant="quiet" disabled={flight.busy} onClick={() => setConfirming(false)}>
        {t('auth.tokens.cancel')}
      </Button>
    </span>
  );
}
