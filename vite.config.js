import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Pinned so Athena and the world-cup-tracker (which defaults to 5174)
  // never collide on the dev/preview port. strictPort makes a clash fail
  // loudly instead of silently serving the wrong app. PORT lets a preview
  // harness run a second instance when 5173 is already taken.
  server: { port: Number(process.env.PORT) || 5173, strictPort: true },
});
