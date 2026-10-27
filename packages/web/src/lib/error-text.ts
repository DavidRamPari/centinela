/**
 * Errors in words (S7b-17): what happened and what to do about it, for the error states,
 * the refresh notice and the rollback messages.
 */
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ZodError } from 'zod';
import { ApiError } from '../api/client';

export type ErrorKind =
  'offline' | 'server' | 'rateLimited' | 'notFound' | 'rejected' | 'contract' | 'other';

/** What kind of failure an error is, to say what to do about it. */
export function errorKind(error: unknown): ErrorKind {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'rateLimited';
    if (error.status === 404) return 'notFound';
    if (error.status === 400 || error.status === 422) return 'rejected';
    if (error.status >= 500) return 'server';
    return 'other';
  }
  // fetch() rejects with a TypeError when the request never got an answer.
  if (error instanceof TypeError) return 'offline';
  if (error instanceof ZodError) return 'contract';
  return 'other';
}

export interface ErrorText {
  title: string;
  /** What to do next, as a sentence. */
  action: string;
  /** The server's status and message, when it answered. */
  detail?: string;
}

export function describeError(t: TFunction, error: unknown): ErrorText {
  const kind = errorKind(error);
  const seconds = error instanceof ApiError ? (error.retryAfterSeconds ?? 10) : 10;
  return {
    title: t(`common.errors.${kind}.title`),
    action: t(`common.errors.${kind}.action`, { seconds }),
    detail:
      error instanceof ApiError
        ? t('common.errorStatus', { status: error.status, message: error.message })
        : undefined,
  };
}

export function useErrorText(error: unknown): ErrorText {
  const { t } = useTranslation();
  return describeError(t, error);
}
