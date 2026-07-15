# Client portal (`client-portal/`)

The **client-facing** portal — a small, standalone Vite + React app, separate
from the staff app at the repo root. Clients sign in with a one-time code and
see their onboarding progress, upload documents, and request services.

It lives in this repo (consolidated from the former standalone
`athena-client-portal` repo, 15/07/2026) so it's version-controlled on GitHub
and auto-deploys, but it is **its own independent build** — root `package.json`
/ Vite config do not apply here.

## Shared backend, separate app
Same Supabase project as the staff app. All data access goes through the
`portal_*` SECURITY DEFINER RPCs (see `sql/schema_client_portal*.sql` at the
repo root). No password — sign-in is a 6-digit code from the `portal-send-code`
edge function, verified client-side with `supabase.auth.verifyOtp`.

## Develop
```
npm --prefix client-portal install    # first time
npm --prefix client-portal run dev     # http://localhost:5175
```
Needs `client-portal/.env` (copy `.env.example`) with `VITE_SUPABASE_URL` +
`VITE_SUPABASE_ANON_KEY`.

## Deploy (Vercel)
Deployed as a **separate Vercel project** whose **Root Directory = `client-portal`**,
connected to this GitHub repo → pushes to `master` auto-deploy it to
`clients.almondvalleyaccounting.co.uk`. Env vars (`VITE_SUPABASE_*`) are set in
that Vercel project.
