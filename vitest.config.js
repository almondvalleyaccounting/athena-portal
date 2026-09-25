import { defineConfig } from 'vitest/config';

// Money-logic tests. Kept apart from vite.config.js so the React plugin and
// dev-server settings don't load for a test run; everything under test here
// is plain JS with no React or Supabase.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
  },
});
