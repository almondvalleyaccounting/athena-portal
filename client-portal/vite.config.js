import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port 5175: Athena dev uses 5173, world-cup-tracker uses 5174.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175, strictPort: true },
  // Monorepo guard: an inline (empty) PostCSS config stops Vite searching up the
  // tree and inheriting the STAFF app's root postcss.config.js (which needs
  // tailwindcss, not installed here). The portal uses plain inline styles — no
  // PostCSS needed. Without this, git-based builds (whole repo cloned) fail.
  css: { postcss: {} },
});
