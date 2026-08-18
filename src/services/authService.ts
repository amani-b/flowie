import { isSupabaseConfigured, supabase } from "./supabaseClient";
import { DEMO_USER } from "../lib/mock";
import { uid } from "../lib/utils";
import type { AppMode, AuthUser } from "../types";
import type { User as SupabaseUser } from "@supabase/supabase-js";

/**
 * Auth service with two interchangeable backends:
 *
 *  - LIVE  → Supabase email auth + Google OAuth (keys configured)
 *  - MOCK  → simulated locally (localStorage registry + session), so the
 *            whole flow — validation, errors, persistence — still works
 *            with zero backend.
 */

export const appMode: AppMode = isSupabaseConfigured ? "live" : "mock";

const USERS_KEY = "fitflow:mock-users";
const SESSION_KEY = "fitflow:mock-session";

interface MockUserRecord {
  id: string;
  email: string;
  name: string;
  pass: string; // demo-only — never do this in a real backend
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------------- mock persistence ------------------------- */

function readMockUsers(): MockUserRecord[] {
  try {
    return JSON.parse(localStorage.getItem(USERS_KEY) ?? "[]") as MockUserRecord[];
  } catch {
    return [];
  }
}

function writeMockUsers(users: MockUserRecord[]) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

export function readMockSession(): AuthUser | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function writeMockSession(user: AuthUser | null) {
  if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  else localStorage.removeItem(SESSION_KEY);
}

/* --------------------------- error mapping -------------------------- */

function friendly(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("invalid login credentials")) return "Incorrect email or password.";
  if (m.includes("already registered"))
    return "That email is already registered — try logging in instead.";
  if (m.includes("rate limit")) return "Too many attempts — wait a moment and retry.";
  if (m.includes("valid email")) return "That email address doesn't look valid.";
  if (m.includes("password should be")) return "Password must be at least 6 characters.";
  if (m.includes("failed to fetch") || m.includes("network"))
    return "Network error — check your connection and retry.";
  return msg;
}

export interface AuthResult {
  user: AuthUser | null;
  /** true when Supabase requires email confirmation before a session exists */
  needsConfirm: boolean;
}

function mapSupabaseUser(u: SupabaseUser): AuthUser {
  const meta = (u.user_metadata ?? {}) as { name?: string; full_name?: string };
  return {
    id: u.id,
    email: u.email ?? "",
    name: meta.name ?? meta.full_name ?? (u.email ?? "stylist").split("@")[0],
    isDemo: false,
  };
}

/* ------------------------------ API --------------------------------- */

export async function signUp(
  email: string,
  password: string,
  name: string
): Promise<AuthResult> {
  const cleanEmail = email.trim().toLowerCase();

  if (!isSupabaseConfigured || !supabase) {
    await wait(850);
    const users = readMockUsers();
    if (users.some((u) => u.email === cleanEmail)) {
      throw new Error("That email is already registered — try logging in instead.");
    }
    const record: MockUserRecord = {
      id: uid("usr"),
      email: cleanEmail,
      name: name.trim(),
      pass: password,
    };
    writeMockUsers([...users, record]);
    const user: AuthUser = {
      id: record.id,
      email: record.email,
      name: record.name,
      isDemo: false,
    };
    writeMockSession(user);
    return { user, needsConfirm: false };
  }

  const { data, error } = await supabase.auth.signUp({
    email: cleanEmail,
    password,
    options: { data: { name: name.trim() } },
  });
  if (error) throw new Error(friendly(error.message));
  if (!data.session || !data.user) return { user: null, needsConfirm: true };
  return { user: mapSupabaseUser(data.user), needsConfirm: false };
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const cleanEmail = email.trim().toLowerCase();

  if (!isSupabaseConfigured || !supabase) {
    await wait(650);
    const record = readMockUsers().find((u) => u.email === cleanEmail);
    if (!record || record.pass !== password) {
      throw new Error("Incorrect email or password.");
    }
    const user: AuthUser = {
      id: record.id,
      email: record.email,
      name: record.name,
      isDemo: false,
    };
    writeMockSession(user);
    return { user, needsConfirm: false };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password,
  });
  if (error || !data.user) throw new Error(friendly(error?.message ?? "Sign-in failed"));
  return { user: mapSupabaseUser(data.user), needsConfirm: false };
}

/** Google OAuth — requires Supabase keys (provider configured in dashboard). */
export async function signInWithGoogle(): Promise<void> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Google sign-in needs Supabase keys — the demo door below is open though.");
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) throw new Error(friendly(error.message));
  // Browser redirects to Google; the session is picked up on return.
}

export async function signOut(): Promise<void> {
  writeMockSession(null);
  if (supabase) {
    try {
      await supabase.auth.signOut();
    } catch {
      /* local session already cleared */
    }
  }
}

/** Instantly enter as the fake demo user with the mock dataset. */
export function enterDemoMode(): AuthUser {
  writeMockSession(DEMO_USER);
  return DEMO_USER;
}

/** Restore a previous session on app boot (mock LS or Supabase). */
export async function restoreSession(): Promise<AuthUser | null> {
  if (!isSupabaseConfigured || !supabase) return readMockSession();
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user ? mapSupabaseUser(data.session.user) : null;
  } catch {
    return null;
  }
}

/** Live-mode only: react to token refresh / OAuth redirect / sign-out. */
export function subscribeAuth(cb: (user: AuthUser | null) => void): () => void {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    cb(session?.user ? mapSupabaseUser(session.user) : null);
  });
  return () => data.subscription.unsubscribe();
}
