/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** "true" to allow billable AI flat-lay calls (default off = free). */
  readonly VITE_ENABLE_FLATLAY_AI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
