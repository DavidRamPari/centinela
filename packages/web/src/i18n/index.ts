/**
 * i18next setup: English and Spanish (neutral Latin American). The chosen language is
 * persisted in localStorage; storage can be unavailable (private mode, blocked site data),
 * so every access is wrapped in try/catch and the app works without it.
 */
import i18next, { type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import es from './es.json';

export const LANGUAGES = ['en', 'es'] as const;
export type Language = (typeof LANGUAGES)[number];
export const LANGUAGE_STORAGE_KEY = 'centinela.language';

export const resources = {
  en: { translation: en },
  es: { translation: es },
} as const;

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

export function readStoredLanguage(): Language | undefined {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function storeLanguage(language: Language): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Storage unavailable: the choice lasts for this page load only.
  }
}

function browserLanguage(): Language {
  const preferred = typeof navigator === 'undefined' ? [] : navigator.languages;
  return preferred.some((lang) => lang.toLowerCase().startsWith('es')) ? 'es' : 'en';
}

export function initialLanguage(): Language {
  return readStoredLanguage() ?? browserLanguage();
}

/** Create and initialize an i18next instance (one per app, one per test). */
export function createI18n(language: Language = initialLanguage()): I18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: 'en',
    supportedLngs: [...LANGUAGES],
    // React escapes rendered text; never render translations as HTML.
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
  });
  instance.on('languageChanged', (lng) => {
    if (isLanguage(lng)) {
      storeLanguage(lng);
      document.documentElement.lang = lng;
    }
  });
  document.documentElement.lang = language;
  return instance;
}
