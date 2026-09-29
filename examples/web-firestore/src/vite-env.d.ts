/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_EMULATOR: string;
  readonly VITE_FIREBASE_CONFIG: string;
  readonly VITE_READMETER_API_KEY: string;
  readonly VITE_READMETER_HASH_KEY: string;
  readonly VITE_READMETER_ENDPOINT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
