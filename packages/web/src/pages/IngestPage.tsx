import {
  SOURCE_TYPES,
  ingestQuerySchema,
  type IngestSummary,
  type SourceType,
} from '@centinela/shared';
import { FileText, Upload } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useUploadLog } from '../api/hooks';
import { Button } from '../components/ui/Button';
import { CopyTextButton } from '../components/ui/CopyButton';
import { Section } from '../components/ui/Section';
import { CodeBlock } from '../components/ui/CodeBlock';
import { SelectField, TextField, labelClass } from '../components/ui/Fields';
import { PageHeader } from '../components/ui/PageHeader';
import { ErrorState } from '../components/ui/States';
import {
  addUploadRecord,
  readUploadHistory,
  type UploadRecord,
} from '../features/ingest/upload-history';
import { useFormat } from '../lib/format';
import { useSingleFlight } from '../lib/single-flight';

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
      <div className="grid grid-cols-1 gap-x-12 gap-y-12 xl:grid-cols-2">
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
  // Busy from the first click: reading the file comes before the request starts.
  const flight = useSingleFlight();
  const fileInputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<SourceType>('linux_auth');
  const [host, setHost] = useState(DEFAULT_HOST.linux_auth);
  const [tz, setTz] = useState('UTC');
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestSummary | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (flight.busy) return;
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
    const params = query.data;
    flight.run(async () => {
      let text: string;
      try {
        text = await file.text();
      } catch {
        setFormError(t('ingest.errors.read'));
        return;
      }
      await upload.mutateAsync(
        { query: params, text },
        {
          onSuccess: (summary) => {
            setResult(summary);
            onUploaded({
              at: new Date().toISOString(),
              fileName: file.name.slice(0, 255),
              source: params.source,
              host: params.host,
              summary,
            });
          },
        },
      );
    });
  }

  return (
    <Section framed title={t('ingest.upload.title')} description={t('ingest.upload.description')}>
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <div className="flex flex-col gap-1.5">
          <span className={labelClass} aria-hidden="true">
            {t('ingest.upload.file')}
          </span>
          {/* A drawn file picker: the native one speaks the browser's language, not the app's. */}
          <div className="flex flex-wrap items-center gap-3">
            <input
              id={fileInputId}
              type="file"
              accept=".log,.txt,.json,.ndjson,text/plain"
              aria-label={t('ingest.upload.file')}
              aria-describedby={`${fileInputId}-hint`}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              disabled={flight.busy}
              className="peer sr-only"
            />
            <label
              htmlFor={fileInputId}
              className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-control border border-line-strong px-3.5 font-semibold text-fg transition-colors duration-100 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-disabled:cursor-not-allowed peer-disabled:border-transparent peer-disabled:bg-disabled peer-disabled:text-disabled-fg hover:border-line-hover hover:bg-hover active:translate-y-px active:bg-pressed"
            >
              <FileText aria-hidden="true" strokeWidth={1.75} className="size-4" />
              {t('ingest.upload.choose')}
            </label>
            <span className="min-w-0 truncate text-muted">
              {file ? file.name : t('ingest.upload.noFile')}
            </span>
          </div>
          <p id={`${fileInputId}-hint`} className="text-small text-muted">
            {t('ingest.upload.limit')}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
          <Button type="submit" variant="primary" icon={Upload} loading={flight.busy}>
            {flight.busy ? t('ingest.upload.sending') : t('ingest.upload.submit')}
          </Button>
        </div>
        {formError ? (
          <p role="alert" className="font-semibold text-danger">
            {formError}
          </p>
        ) : null}
        {upload.isError ? <ErrorState error={upload.error} /> : null}
        {result ? <SummaryView summary={result} /> : null}
      </form>
    </Section>
  );
}

function SummaryView({ summary }: { summary: IngestSummary }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <div role="status" className="flex flex-col gap-2 border-t border-line pt-4">
      <p className="font-semibold text-fg">{t('ingest.result.title')}</p>
      <ul className="grid grid-cols-2 gap-1 sm:grid-cols-4">
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
          <p className="text-small font-semibold text-fg">{t('ingest.result.rejections')}</p>
          <ul className="font-mono text-small">
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
  const origin = window.location.origin;
  const command = [
    `curl -X POST "${origin}/api/ingest?source=linux_auth&host=bastion-01&tz=America/Lima" \\`,
    '  -H "Authorization: Bearer $INGEST_TOKEN" \\',
    '  -H "Content-Type: text/plain" \\',
    '  --data-binary @/var/log/auth.log',
  ].join('\n');

  return (
    <Section
      title={t('ingest.curl.title')}
      description={t('ingest.curl.description')}
      actions={<CopyTextButton size="sm" value={command} label={t('ingest.curl.copy')} />}
    >
      <CodeBlock text={command} label={t('ingest.curl.title')} />
      <p className="text-muted">{t('ingest.curl.ndjson')}</p>
    </Section>
  );
}

function HistoryCard({ history }: { history: UploadRecord[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Section title={t('ingest.history.title')} className="xl:col-span-2" divider>
      {history.length === 0 ? (
        <p className="text-muted">{t('ingest.history.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{t('ingest.history.title')}</caption>
            <thead className="border-b border-line-strong text-small text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t('ingest.history.when')}
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t('ingest.history.file')}
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t('ingest.upload.source')}
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t('ingest.upload.host')}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-semibold">
                  {t('ingest.history.accepted')}
                </th>
                <th scope="col" className="py-2 text-right font-semibold">
                  {t('ingest.history.rejected')}
                </th>
              </tr>
            </thead>
            <tbody>
              {history.map((record) => (
                <tr key={`${record.at}-${record.fileName}`} className="border-b border-line">
                  <td className="py-2 pr-4 text-muted">
                    <time dateTime={record.at}>{format.dateTime(record.at)}</time>
                  </td>
                  <td className="max-w-[14rem] truncate py-2 pr-4 font-mono text-small">
                    {record.fileName}
                  </td>
                  <td className="py-2 pr-4">{t(`sources.${record.source}`)}</td>
                  <td className="py-2 pr-4">{record.host}</td>
                  <td className="py-2 pr-4 text-right">{format.number(record.summary.accepted)}</td>
                  <td className="py-2 text-right">{format.number(record.summary.rejected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
