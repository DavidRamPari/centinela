/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" runs the dashboard against MSW mocks instead of the API. */
  readonly VITE_USE_MOCKS?: string;
  /** Public origin for link previews; read at build time by link-preview/vite-plugin.ts. */
  readonly VITE_PUBLIC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
