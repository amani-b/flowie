import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor wraps the same Vite build the PWA already ships — one codebase,
 * no React Native, no Kotlin UI.
 *
 * Kept deliberately minimal. Three options that look useful here are
 * documented no-ops on this target and are therefore NOT set, because config
 * that reads like it does something is worse than no config:
 *
 *  - `StatusBar.overlaysWebView` and `StatusBar.backgroundColor` — the plugin
 *    types say "Not available on Android 15+". The app targets SDK 36
 *    (Android 16), where edge-to-edge is enforced by the platform and the
 *    status bar is always overlaid, so both are dead settings.
 *  - `android.backgroundColor` — same 15+ restriction.
 *
 * What is NOT frozen here is the status bar *style*: that is still settable, so
 * it is driven at runtime from the app's own theme (see `src/lib/native.ts`)
 * and follows dark/light instead of being pinned at build time.
 *
 * Not set, on purpose: `server.url` / `server.cleartext`. The app loads only
 * its own bundled assets. Live reload is a local dev concern and lives in
 * `scripts/capacitor.live-reload.mjs`, which is gitignored.
 */
const config: CapacitorConfig = {
  appId: "app.flowie",
  appName: "Flowie",
  webDir: "dist",

  /**
   * The web layer is dark-first. Matching the native window background to
   * `--bg` dark means no white flash between the splash and the first paint.
   */
  backgroundColor: "#0C110D",

  android: {
    // Bundled assets only — never allow plaintext content in the WebView.
    allowMixedContent: false,
  },
};

export default config;
