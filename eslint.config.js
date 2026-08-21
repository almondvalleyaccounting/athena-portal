import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

/*
  ESLint — one rule, deliberately.

  Added 2026-08-21 after clicking the P&L tab blanked the whole Client
  Dashboard: `reportMonthKeys` was called in two components but never added to
  the import, so it was a bare global reference. An undefined identifier is
  valid JavaScript until the line runs, so `vite build` was perfectly happy and
  Vercel went green — the check this project relies on to call a deploy safe is
  blind to the entire class. It reached production and stayed there.

  `no-undef` is the rule that catches it, and it is the whole point of this
  file. Everything else is off on purpose: a config that reports hundreds of
  style opinions on a codebase this size gets ignored within a week, and then
  it catches nothing at all. Add rules when a real bug argues for them, the way
  this one did.

  Run it with `npm run lint`. Both apps are covered — the staff app in src/ and
  the client portal, which is a separate npm project but the same kind of code.
*/

export default [
  {
    /*
      The codebase already carries `eslint-disable-next-line
      react-hooks/exhaustive-deps` comments in about twenty files. ESLint errors
      on a disable comment naming a rule it has never heard of, so the plugin is
      registered to make those names resolve — but every one of its rules stays
      OFF. Nothing here is asking the exhaustive-deps question yet; that is a
      real piece of work with real findings, and it is not this change.

      Unused-directive reporting is off for the same reason: while those rules
      are off their directives are dormant, not wrong, and flagging twenty of
      them would bury the one error that matters.
    */
    plugins: { 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    ignores: [
      '**/node_modules/**',
      // Agent worktrees are whole copies of the repo. Linting them doubles the
      // run and reports findings against code that is not on this branch.
      '.claude/**',
      '**/dist/**',
      '**/build/**',
      '.vercel/**',
      // Edge functions are Deno TypeScript: a different runtime with different
      // globals, and espree cannot parse .ts at all. Linting them needs the
      // TypeScript parser and a Deno globals set — worth doing, not today.
      'supabase/functions/**',
    ],
  },

  // Browser code: both apps.
  {
    files: ['src/**/*.{js,jsx}', 'client-portal/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Off by default in flat config, so it is named explicitly rather than
      // inherited — if someone swaps the preset below, this must survive.
      'no-undef': 'error',
    },
  },

  // The build and admin scripts: Node, CommonJS.
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-undef': 'error',
    },
  },

  // Node ES modules at the root (this file, vite config, tailwind config).
  {
    files: ['*.js', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
