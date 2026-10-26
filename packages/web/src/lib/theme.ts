/**
 * Dark (default) and light themes. The `dark` class on <html> switches the CSS tokens in
 * index.css; the choice is persisted in localStorage when available.
 */
import { useSyncExternalStore } from 'react';
import { readStorage, writeStorage } from './storage';

export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_STORAGE_KEY = 'centinela.theme';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function initialTheme(): Theme {
  const stored = readStorage(THEME_STORAGE_KEY);
  return isTheme(stored) ? stored : 'dark';
}

const listeners = new Set<() => void>();

export function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  for (const listener of listeners) listener();
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  writeStorage(THEME_STORAGE_KEY, theme);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => 'dark');
}
