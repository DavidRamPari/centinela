import 'i18next';
import type en from './en.json';

// Type-checked translation keys: `t('nav.alerts')` compiles, `t('nav.typo')` does not.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
