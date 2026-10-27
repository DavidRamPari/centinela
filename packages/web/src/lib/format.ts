/**
 * Locale-aware formatting for the selected UI language: Latin American Spanish (`es-419`)
 * or US English. Dates are shown in the browser's time zone; `<time dateTime>` keeps UTC.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export function localeFor(language: string | undefined): string {
  return language?.startsWith('es') ? 'es-419' : 'en-US';
}

export interface Formatters {
  locale: string;
  dateTime(iso: string): string;
  time(iso: string): string;
  shortDateTime(iso: string): string;
  /** Month, day and time with seconds, for log events. */
  eventTime(iso: string): string;
  number(value: number): string;
  /** Time of day with seconds, e.g. "3:18:00 AM". */
  timeWithSeconds(iso: string): string;
  /** "12 minutes ago", relative to `now`. */
  relative(iso: string, now?: number): string;
  /** A span of time in words, e.g. "2 min 24 s". */
  span(ms: number): string;
  bytes(value: number): string;
  durationMs(value: number): string;
}

export function createFormatters(locale: string): Formatters {
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' });
  const shortDateTime = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const eventTime = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const timeWithSeconds = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' });
  const unit = (value: number, name: 'hour' | 'minute' | 'second' | 'day') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(
      value,
    );
  const number = new Intl.NumberFormat(locale);
  const seconds = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const units = ['B', 'kB', 'MB', 'GB'] as const;
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

  return {
    locale,
    dateTime: (iso) => dateTime.format(new Date(iso)),
    time: (iso) => time.format(new Date(iso)),
    shortDateTime: (iso) => shortDateTime.format(new Date(iso)),
    eventTime: (iso) => eventTime.format(new Date(iso)),
    number: (value) => number.format(value),
    timeWithSeconds: (iso) => timeWithSeconds.format(new Date(iso)),
    relative: (iso, now = Date.now()) => {
      const seconds = Math.round((Date.parse(iso) - now) / 1000);
      const abs = Math.abs(seconds);
      if (abs < 60) return relative.format(seconds, 'second');
      if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
      if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
      return relative.format(Math.round(seconds / 86_400), 'day');
    },
    span: (ms) => {
      const total = Math.max(0, Math.round(ms / 1000));
      const days = Math.floor(total / 86_400);
      const hours = Math.floor((total % 86_400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const parts: string[] = [];
      if (days) parts.push(unit(days, 'day'));
      if (hours) parts.push(unit(hours, 'hour'));
      if (minutes && !days) parts.push(unit(minutes, 'minute'));
      if (!days && !hours && (seconds || parts.length === 0)) parts.push(unit(seconds, 'second'));
      return parts.join(' ');
    },
    bytes: (value) => {
      let unit = 0;
      let scaled = value;
      while (scaled >= 1000 && unit < units.length - 1) {
        scaled /= 1000;
        unit += 1;
      }
      return `${decimal.format(scaled)} ${units[unit] ?? 'B'}`;
    },
    durationMs: (value) =>
      value < 1000 ? `${number.format(Math.round(value))} ms` : `${seconds.format(value / 1000)} s`,
  };
}

export function useFormat(): Formatters {
  const { i18n } = useTranslation();
  const locale = localeFor(i18n.resolvedLanguage ?? i18n.language);
  return useMemo(() => createFormatters(locale), [locale]);
}
