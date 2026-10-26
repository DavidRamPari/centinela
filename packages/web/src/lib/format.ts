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
  number(value: number): string;
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
  const number = new Intl.NumberFormat(locale);
  const seconds = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const units = ['B', 'kB', 'MB', 'GB'] as const;
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

  return {
    locale,
    dateTime: (iso) => dateTime.format(new Date(iso)),
    time: (iso) => time.format(new Date(iso)),
    shortDateTime: (iso) => shortDateTime.format(new Date(iso)),
    number: (value) => number.format(value),
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
