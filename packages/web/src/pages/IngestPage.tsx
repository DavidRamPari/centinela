import {
  SOURCE_TYPES,
  ingestQuerySchema,
  type IngestSummary,
  type SourceType,
} from '@centinela/shared';
import { Copy, Upload } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useUploadLog } from '../api/hooks';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { CodeBlock } from '../components/ui/CodeBlock';
import { SelectField, TextField } from '../components/ui/Fields';
import { PageHeader } from '../components/ui/PageHeader';
import { ErrorState } from '../components/ui/States';
import { useToasts } from '../components/ui/toast-context';
import {
  addUploadRecord,
  readUploadHistory,
  type UploadRecord,
} from '../features/ingest/upload-history';
import { useFormat } from '../lib/format';

/** Same limit as the server (ARCHITECTURE §9, §12): checked before reading the file. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const DEFAULT_HOST: Readonly<Record<SourceType, string>> = {
  linux_auth: 'bastion-01',
  nginx_access: 'web-01',
  apache_access: 'intranet-01',
  sysmon: 'ws-0142',
};

export default function IngestPage() {
  const { t } = useTranslation();
  const [history, setHistory] = useState<UploadRecord[]>(readUploadHistory);
  return (
    <section>
      <PageHeader title={t('pages.ingest.title')} description={t('pages.ingest.description')} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <UploadCard
          onUploaded={(record) => setHistory((current) => addUploadRecord(current, record))}
        />
        <CurlCard />
        <HistoryCard history={history} />
      </div>
    </section>
  );
}

function UploadCard({ onUploaded }: { onUploaded: (record: UploadRecord) => void }) {
  const { t } = useTranslation();
  const upload = useUploadLog();
  const fileInputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<SourceType>('linux_auth');
  const [host, setHost] = useState(DEFAULT_HOST.linux_auth);
  const [tz, setTz] = useState('UTC');
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestSummary | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setResult(null);
    if (!file) {
      setFormError(t('ingest.errors.noFile'));
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setFormError(t('ingest.errors.tooLarge'));
      return;
    }
    const query = ingestQuerySchema.safeParse({ source, host, tz });
    if (!query.success) {
      const field = String(query.error.issues[0]?.path[0] ?? '');
      setFormError(field === 'tz' ? t('ingest.errors.tz') : t('ingest.errors.host'));
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setFormError(t('ingest.errors.read'));
      return;
    }
    upload.mutate(
      { query: query.data, text },
      {
        onSuccess: (summary) => {
          setResult(summary);
          onUploaded({
            at: new Date().toISOString(),
            fileName: file.name.slice(0, 255),
            source: query.data.source,
            host: query.data.host,
            summary,
          });
        },
      },
    );
  }

  return (
    <Card title={t('ingest.upload.title')}>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3" noValidate>
        <div className="flex flex-col gap-1">
          <label htmlFor={fileInputId} className="text-xs font-medium text-muted">
            {t('ingest.upload.file')}
          </label>
          <input
            id={fileInputId}
            type="file"
            accept=".log,.txt,.json,.ndjson,text/plain"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="text-fg file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-fg"
          />
          <p className="text-xs text-muted">{t('ingest.upload.limit')}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SelectField
            label={t('ingest.upload.source')}
            value={source}
            onChange={(event) => {
              const next =
                SOURCE_TYPES.find((value) => value === event.target.value) ?? 'linux_auth';
              setSource(next);
              setHost(DEFAULT_HOST[next]);
            }}
            options={SOURCE_TYPES.map((value) => ({ value, label: t(`sources.${value}`) }))}
          />
          <TextField
            label={t('ingest.upload.host')}
            value={host}
            onChange={(event) => setHost(event.target.value)}
            maxLength={255}
            spellCheck={false}
            hint={t('ingest.upload.hostHint')}
          />
          <TextField
            label={t('ingest.upload.tz')}
            value={tz}
            onChange={(event) => setTz(event.target.value)}
            maxLength={64}
            spellCheck={false}
            hint={t('ingest.upload.tzHint')}
          />
        </div>
        <div>
          <Button type="submit" variant="primary" disabled={upload.isPending}>
            <Upload aria-hidden="true" className="size-4" />
            {upload.isPending ? t('ingest.upload.sending') : t('ingest.upload.submit')}
          </Button>
        </div>
        {formError ? (
          <p role="alert" className="text-danger">
            {formError}
          </p>
        ) : null}
        {upload.isError ? <ErrorState error={upload.error} /> : null}
        {result ? <SummaryView summary={result} /> : null}
      </form>
    </Card>
  );
}

function SummaryView({ summary }: { summary: IngestSummary }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3"
    >
      <p className="font-medium text-fg">{t('ingest.result.title')}</p>
      <ul className="grid grid-cols-2 gap-1 text-sm sm:grid-cols-4">
        <li>{t('ingest.result.accepted', { value: format.number(summary.accepted) })}</li>
        <li>{t('ingest.result.rejected', { value: format.number(summary.rejected) })}</li>
        <li>
          {t('ingest.result.alerts', {
            value: format.number(summary.alertsCreated + summary.alertsUpdated),
          })}
        </li>
        <li>{t('ingest.result.duration', { value: format.durationMs(summary.durationMs) })}</li>
      </ul>
      {summary.rejections.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-muted">{t('ingest.result.rejections')}</p>
          <ul className="font-mono text-xs">
            {summary.rejections.map((rejection) => (
              <li key={rejection.line}>
                {t('ingest.result.line', { line: format.number(rejection.line) })}:{' '}
                {rejection.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function CurlCard() {
  const { t } = useTranslation();
  const { push } = useToasts();
  const origin = window.location.origin;
  const command = [
    `curl -X POST "${origin}/api/ingest?source=linux_auth&host=bastion-01&tz=America/Lima" \\`,
    '  -H "Authorization: Bearer $INGEST_TOKEN" \\',
    '  -H "Content-Type: text/plain" \\',
    '  --data-binary @/var/log/auth.log',
  ].join('\n');

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      push({ title: t('ingest.curl.copied') });
    } catch {
      push({ title: t('ingest.curl.copyFailed') });
    }
  }

  return (
    <Card
      title={t('ingest.curl.title')}
      actions={
        <Button size="sm" onClick={() => void copy()}>
          <Copy aria-hidden="true" className="size-3.5" />
          {t('ingest.curl.copy')}
        </Button>
      }
    >
      <p className="mb-2 text-muted">{t('ingest.curl.description')}</p>
      <CodeBlock text={command} label={t('ingest.curl.title')} />
      <p className="mt-2 text-xs text-muted">{t('ingest.curl.ndjson')}</p>
    </Card>
  );
}

function HistoryCard({ history }: { history: UploadRecord[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Card title={t('ingest.history.title')} className="xl:col-span-2">
      {history.length === 0 ? (
        <p className="text-muted">{t('ingest.history.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{t('ingest.history.title')}</caption>
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('ingest.history.when')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('ingest.history.file')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('ingest.upload.source')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('ingest.upload.host')}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('ingest.history.accepted')}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {t('ingest.history.rejected')}
                </th>
              </tr>
            </thead>
            <tbody>
              {history.map((record) => (
                <tr key={`${record.at}-${record.fileName}`} className="border-t border-line">
                  <td className="py-1 pr-3 text-muted">
                    <time dateTime={record.at}>{format.dateTime(record.at)}</time>
                  </td>
                  <td className="max-w-[14rem] truncate py-1 pr-3 font-mono text-xs">
                    {record.fileName}
                  </td>
                  <td className="py-1 pr-3">{t(`sources.${record.source}`)}</td>
                  <td className="py-1 pr-3 font-mono text-xs">{record.host}</td>
                  <td className="py-1 pr-3 text-right">{format.number(record.summary.accepted)}</td>
                  <td className="py-1 text-right">{format.number(record.summary.rejected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
