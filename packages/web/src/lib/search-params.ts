/** Helpers for filters kept in the URL (ARCHITECTURE §11: the URL is the source of truth). */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

export type ParamUpdates = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Copy of `params` with `updates` applied; empty values and empty lists remove the key. */
export function applyParamUpdates(params: URLSearchParams, updates: ParamUpdates): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      next.delete(key);
    } else {
      next.set(key, Array.isArray(value) ? value.join(',') : (value as string));
    }
  }
  return next;
}

/** Comma-separated list param, keeping only allowed values. */
export function readListParam<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
): T[] {
  const raw = params.get(key);
  if (!raw) return [];
  const values = raw.split(',').map((part) => part.trim());
  return allowed.filter((value) => values.includes(value));
}

/** Short free-text param (trimmed, at most 256 characters as in the API contract). */
export function readTextParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value ? value.slice(0, 256) : undefined;
}

export function useParamUpdater() {
  const [, setSearchParams] = useSearchParams();
  return useCallback(
    (updates: ParamUpdates | ((params: URLSearchParams) => URLSearchParams)) => {
      setSearchParams((prev) =>
        typeof updates === 'function' ? updates(prev) : applyParamUpdates(prev, updates),
      );
    },
    [setSearchParams],
  );
}
