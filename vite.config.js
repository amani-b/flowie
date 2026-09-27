import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      manifest: false, // Use existing public/manifest.webmanifest
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
      },
      // No runtimeCaching - let Zustand-persisted store handle data caching
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
    hmr: {
      port: 5173,
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Separate large vendor libraries into chunks.
          //
          // This list is audited against what the app ACTUALLY imports, not
          // against package.json. It previously named `clsx`, which is never
          // imported (`cn()` in lib/utils.ts is hand-rolled) — Rollup dropped
          // the chunk entirely and emitted the BASELINE.md warning about a
          // named-but-missing module. `uuid` and `date-fns` turned out to be
          // equally dead: every `uuid` in the source is the string literal in
          // `uid("uuid")`, and `date-fns` has no import site at all. Naming a
          // module here that nothing imports produces an EMPTY CHUNK, which
          // is its own build warning. So: only modules with a real import
          // path are chunked, and `zustand` (genuinely used by the persist
          // layer) takes the freed slot — keeping it out of the app chunk
          // means a store-only change does not invalidate the app bundle.
          'vendor-framer': ['framer-motion'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-lucide': ['lucide-react'],
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-state': ['zustand'],
        },
      },
    },
    // Increase chunk size warning limit to 600KB
    chunkSizeWarningLimit: 600,
  },
});
