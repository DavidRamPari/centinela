/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" runs the dashboard against MSW mocks instead of the API. */
  readonly VITE_USE_MOCKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
