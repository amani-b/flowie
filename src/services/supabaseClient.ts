import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase singleton.
 *
 * If VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are absent the app runs
 * in MOCK MODE: `supabase` is null, auth is simulated locally and all
 * data lives on-device. Every service checks `isSupabaseConfigured`
 * and branches accordingly — no code path assumes a backend.
 *
 * Typing note: rows are typed at the service/mapping layer against the
 * interfaces in src/types/database.ts (the installed supabase-js build
 * rejects partial codegen-style Database generics), which keeps queries
 * honest while remaining version-proof.
 */

const url = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();

export const isSupabaseConfigured: boolean =
  url.length > 0 && anonKey.length > 0;

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true, // needed for the OAuth redirect
      },
    })
  : null;

/** Base project URL, e.g. https://abcdwxyz.supabase.co (no trailing slash). */
export const supabaseUrl: string = url.replace(/\/+$/, "");
