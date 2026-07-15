import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port 5175: Athena dev uses 5173, world-cup-tracker uses 5174.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175, strictPort: true },
});
