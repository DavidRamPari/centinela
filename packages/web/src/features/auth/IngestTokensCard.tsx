/**
 * Ingest tokens: create one (its secret is shown once, with a copy button), list them and
 * revoke them. Revoking asks for a second click instead of a browser dialog.
 */
import {
  MAX_TOKEN_LABEL_LENGTH,
  ingestTokenCreateBodySchema,
  type IngestToken,
  type IngestTokenCreated,
} from '@centinela/shared';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { TextField } from '../../components/ui/Fields';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { useToasts } from '../../components/ui/toast-context';
import { useFormat } from '../../lib/format';
import { useCreateToken, useRevokeToken, useTokens } from './hooks';

export function IngestTokensCard() {
  const { t } = useTranslation();
  const tokens = useTokens();
  const [created, setCreated] = useState<IngestTokenCreated | null>(null);

  return (
    <Card title={t('auth.tokens.title')} className="xl:col-span-2">
      <p className="mb-3 text-muted">{t('auth.tokens.description')}</p>
      <CreateTokenForm onCreated={setCreated} />
      {created ? <NewSecret created={created} onDismiss={() => setCreated(null)} /> : null}
      <div className="mt-4">
        {tokens.isPending ? (
          <LoadingState />
        ) : tokens.isError ? (
          <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
        ) : tokens.data.items.length === 0 ? (
          <EmptyState title={t('auth.tokens.empty')} />
        ) : (
          <TokensTable tokens={tokens.data.items} />
        )}
      </div>
    </Card>
  );
}

function CreateTokenForm({ onCreated }: { onCreated: (created: IngestTokenCreated) => void }) {
  const { t } = useTranslation();
  const create = useCreateToken();
  const [label, setLabel] = useState('');
  const [invalid, setInvalid] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const body = ingestTokenCreateBodySchema.safeParse({ label });
    setInvalid(!body.success);
    if (!body.success) return;
    create.mutate(body.data.label, {
      onSuccess: (result) => {
        setLabel('');
        onCreated(result);
      },
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" noValidate>
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label={t('auth.tokens.label')}
          hint={t('auth.tokens.labelHint')}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={MAX_TOKEN_LABEL_LENGTH}
          spellCheck={false}
          className="min-w-[14rem] flex-1"
        />
        <Button type="submit" variant="primary" disabled={create.isPending} className="mb-5">
          <Plus aria-hidden="true" className="size-4" />
          {create.isPending ? t('auth.tokens.creating') : t('auth.tokens.create')}
        </Button>
      </div>
      {invalid ? (
        <p role="alert" className="text-danger">
          {t('auth.tokens.labelInvalid')}
        </p>
      ) : null}
      {create.isError ? <ErrorState error={create.error} /> : null}
    </form>
  );
}

function NewSecret({ created, onDismiss }: { created: IngestTokenCreated; onDismiss: () => void }) {
  const { t } = useTranslation();
  const { push } = useToasts();

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.secret);
      push({ title: t('auth.tokens.copied') });
    } catch {
      push({ title: t('auth.tokens.copyFailed') });
    }
  }

  return (
    <div role="status" className="mt-3 flex flex-col gap-2 rounded-md border border-accent p-3">
      <p className="flex items-center gap-2 font-medium text-fg">
        <KeyRound aria-hidden="true" className="size-4 text-accent" />
        {t('auth.tokens.createdTitle', { label: created.token.label })}
      </p>
      <p className="text-muted">{t('auth.tokens.createdWarning')}</p>
      <CodeBlock text={created.secret} label={t('auth.tokens.secret')} />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void copy()}>
          <Copy aria-hidden="true" className="size-3.5" />
          {t('auth.tokens.copy')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t('auth.tokens.dismiss')}
        </Button>
      </div>
    </div>
  );
}

function TokensTable({ tokens }: { tokens: IngestToken[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  const columns: Array<Column<IngestToken>> = [
    { id: 'label', header: t('auth.tokens.label'), cell: (token) => token.label },
    {
      id: 'prefix',
      header: t('auth.tokens.prefix'),
      cell: (token) => <span className="font-mono text-xs">{token.prefix}…</span>,
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
        disabled={revoke.isPending}
        aria-label={t('auth.tokens.confirmRevokeLabel', { label: token.label })}
        onClick={() => revoke.mutate(token.id, { onSettled: () => setConfirming(false) })}
      >
        {t('auth.tokens.confirmRevoke')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        {t('auth.tokens.cancel')}
      </Button>
    </span>
  );
}
