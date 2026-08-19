import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = path.resolve(here, '../src/modules/client-dashboard');

// Port 5175: Athena dev uses 5173, world-cup-tracker uses 5174.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    // The dashboard maths is shared with the staff app (see the alias below),
    // which lives outside this project root, so Vite's dev file server has to
    // be told it may read it.
    fs: { allow: [here, shared] },
  },

  /*
    @dash — the Client Dashboard's PURE modules, shared with the staff app.

    A client and a member of staff looking at the same company must see the same
    number. Copying the bucketing, the owner-cost arithmetic and the projection
    engine into this app would have guaranteed the opposite within a couple of
    months, so both apps import one copy.

    ONLY genuinely pure modules may be reached through this alias — formatters,
    date maths, chart SVG, the projection engine. Each one has been checked to
    import nothing but React and its own siblings: no supabase client, no auth,
    no staff tables. Anything that touches those must NOT be pulled in here; the
    portal's data comes exclusively from the portal-dashboard edge function,
    which decides for itself what a client may see.
  */
  resolve: { alias: { '@dash': shared } },

  // Monorepo guard: an inline (empty) PostCSS config stops Vite searching up the
  // tree and inheriting the STAFF app's root postcss.config.js (which needs
  // tailwindcss, not installed here). The portal uses plain inline styles — no
  // PostCSS needed. Without this, git-based builds (whole repo cloned) fail.
  css: { postcss: {} },
});
