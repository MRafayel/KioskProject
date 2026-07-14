/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_UPLOAD_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
