import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { StatusBar, Style } from "@capacitor/status-bar";
import type { PluginListenerHandle } from "@capacitor/core";
import type { ThemeMode } from "../types";

/**
 * The ONLY module in the app that imports Capacitor.
 *
 * Everything native funnels through here so the rest of the codebase stays
 * platform-agnostic and the browser build keeps working untouched: on web every
 * export either does nothing or falls back to the behaviour the app already
 * had. Nothing here may import the store — the store imports this.
 */

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export function platform(): string {
  return Capacitor.getPlatform();
}

/**
 * Point the status bar at the app's current theme.
 *
 * The `Style` enum names are inverted relative to how they read: `Style.Dark`
 * means *light text* (for a dark background) and `Style.Light` means dark text.
 * So a dark app theme maps to `Style.Dark`.
 *
 * No `setBackgroundColor` call: it is a documented no-op on Android 15+, where
 * the bar is always overlaid and its background comes from whatever the web
 * layer paints underneath it.
 */
export async function syncStatusBar(theme: ThemeMode): Promise<void> {
  if (!isNative()) return;
  try {
    await StatusBar.setStyle({
      style: theme === "dark" ? Style.Dark : Style.Light,
    });
  } catch {
    /* cosmetic only — never worth breaking a theme switch over */
  }
}

/**
 * Short UI feedback. Replaces the bare `navigator.vibrate` the store used.
 *
 * On device this is a real haptic tick rather than a timed buzz — Android's
 * predefined `EFFECT_TICK` respects the system haptic settings, including the
 * user having turned touch feedback off, which a raw `vibrate()` does not.
 * The `ms` argument is kept because the web fallback is still a timed
 * vibration and callers already pass it.
 */
export async function haptic(ms = 8): Promise<void> {
  if (!isNative()) {
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* no haptics — fine */
    }
    return;
  }
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Some devices/ROMs refuse `impact`; a timed vibration is the honest
    // fallback rather than dropping the feedback entirely.
    try {
      await Haptics.vibrate({ duration: ms });
    } catch {
      /* no haptics — fine */
    }
  }
}

/**
 * Subscribe to the Android hardware back button. Returns an unsubscribe fn.
 *
 * Registering this listener disables Capacitor's own default back handling, so
 * the caller is responsible for every case — including exiting. `addListener`
 * is async, hence the `cancelled` guard: without it, unmounting before the
 * handle resolves would leak a listener that can never be removed.
 */
export function onBackButton(handler: () => void): () => void {
  if (!isNative()) return () => {};

  let handle: PluginListenerHandle | null = null;
  let cancelled = false;

  void App.addListener("backButton", () => handler())
    .then((h) => {
      if (cancelled) void h.remove();
      else handle = h;
    })
    .catch(() => {
      /* plugin unavailable — back button simply keeps its default behaviour */
    });

  return () => {
    cancelled = true;
    if (handle) void handle.remove();
  };
}

export async function exitApp(): Promise<void> {
  if (!isNative()) return;
  try {
    await App.exitApp();
  } catch {
    /* nothing further we can do */
  }
}
