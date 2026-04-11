# Athena Portal — AVA Practice Management

Internal portal for Almond Valley Accounting. Quote Builder is the first module.

## Tech Stack

- **React 18** + **Vite** — fast dev/build
- **Tailwind CSS 3** — utility styling
- **Supabase** — auth, database, RLS
- **Deployment target:** Vercel (or Netlify)

## Environment Variables

Create `.env` in the project root (or set in Vercel dashboard):

```
VITE_SUPABASE_URL=https://neksyvneljgxvpchwgch.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5la3N5dm5lbGpneHZwY2h3Z2NoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MDg2NjEsImV4cCI6MjA5MTM4NDY2MX0.fAF6XY0aAYNU9JbpeugNkyd1dXhoQcC3euJJeyzjmuU
```

## Setup

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build to dist/
```

## First-Time Bootstrap

1. Open the portal and click "Create Account" with your email/password.
2. Supabase Auth creates the user. If email confirmation is enabled, confirm via inbox first.
3. The portal detects no `staff_profiles` row and shows the SQL to run.
4. Go to Supabase Dashboard → SQL Editor → paste and run the SQL shown.
5. Click "I've done it — retry" in the portal.
6. You're in with full admin permissions.

## Architecture

### File Structure

```
src/
  lib/
    supabase.js          Supabase client init
    defaults.js          INITIAL_DEFAULTS fallback (fee schedule)
  components/
    ui.jsx               Shared UI: Inp, TabRow, Section, StatusBadge, Btn
    DirectorCard.jsx     Director tax return card with add-ons
    NavShell.jsx         Sidebar navigation wrapper
  pages/
    LoginPage.jsx        Auth: sign in / sign up
    BootstrapPage.jsx    First-run: staff_profiles setup instructions
    DashboardPage.jsx    Overview stats + recent quotes
    EntitiesPage.jsx     Client browser (reads entities table)
    QuotesPage.jsx       Quote list with status badges
    QuoteFormPage.jsx    Full quote builder form, saves to Supabase
  App.jsx                Root: auth state, routing, defaults loading
  main.jsx               Entry point
  index.css              Tailwind directives
```

### Data Flow

1. **Auth** — Supabase Auth email/password. Session token held in React state.
   Supabase JS client handles token refresh automatically.
2. **Staff profile** — After auth, query `staff_profiles` for the user's UUID.
   If no row → show bootstrap page. If row exists → check permission flags.
3. **Defaults** — Query `quote_defaults` where `is_current = true`.
   If no rows → fall back to INITIAL_DEFAULTS from `lib/defaults.js`.
   The form uses whichever source is available.
4. **Entities** — Read from `entities` table (BrightManager pipeline data).
   QuoBu never writes to this table.
5. **Quote creation** — Form builds the quote, saves to `quotes` table,
   then inserts `quote_line_items` rows. Quote ref generated with
   `{Name}_{YYYYMMDD}_{NNN}` format, retry on collision.
6. **Totals** — All computed by the form before save. Application-level
   contract: totals always recalculated on every save. No partial updates.

### Supabase Tables (QuoBu touches)

Read only: `entities`, `services`, `staff_profiles`
Read/write: `quotes`, `quote_line_items`, `quote_defaults`, `billing_groups`,
            `billing_group_members`, `quote_entities`, `entity_fees`, `audit_log`

Full schema documented in `Athena_QuoteBuilder_TechnicalSpec_v1_3.docx`.

### RLS

All tables have RLS enabled. Policies check `staff_profiles` boolean flags.
The anon key + user JWT is the auth model. No service role key in the client.

## Deployment (Vercel)

1. Push to GitHub repo
2. Connect repo in Vercel dashboard
3. Set env vars: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
4. Framework preset: Vite
5. Build command: `npm run build`
6. Output directory: `dist`
7. Deploy

Custom domain: configure in Vercel → Settings → Domains.

## Dev Backlog (logged, not blocking)

- Password show/hide toggle on login
- Confirm password field on signup
- Defaults editor page (read/write quote_defaults from portal)
- Quote edit/reload from saved quotes
- Quote approval workflow (status transitions)
- Multi-entity group quotes
- Modulr, Management Accounts, Review Meetings, Budget & Forecast, CFO sections
- Quote PDF export
