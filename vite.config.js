import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
          // Separate large vendor libraries into chunks
          'vendor-framer': ['framer-motion'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-lucide': ['lucide-react'],
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-utils': ['clsx', 'uuid', 'date-fns'],
        },
      },
    },
    // Increase chunk size warning limit to 600KB
    chunkSizeWarningLimit: 600,
  },
});
