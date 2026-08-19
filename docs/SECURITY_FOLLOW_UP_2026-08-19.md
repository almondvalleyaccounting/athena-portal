# Security follow-up — open items as at 2026-08-19

Everything below is **outstanding**. What was already fixed is at the bottom for context.
Nothing here is a live known-exploitable hole in the database: the audit
(`select * from public.security_posture_audit();`) returns zero rows, and a `pg_cron`
job re-checks that every 15 minutes and notifies `can_manage_portal` if it ever stops.

---

## A. Yours — Supabase dashboard, about five minutes

### A1. Allowed Redirect URLs — do this one first
**Auth → URL Configuration.**

`src/shell/LoginPage.jsx` sends `redirectTo: ${window.location.origin}/login` on a
password reset. If the allow-list contains a wildcard (`https://**`,
`http://localhost:*`, or similar), an attacker can craft a reset link that delivers the
**recovery token to a host they control** — that is full account takeover of a staff
account, and staff accounts see every client's financials.

What you want to see: only the real origins, no wildcards. Specifically
`https://portal.almondvalleyaccounting.co.uk/**` and whatever the client portal uses.
If there is a bare wildcard, remove it.

This is the highest-severity item on the whole list, and it is a five-second look.
It came from the review and I could not check it myself — it is dashboard-only.

### A2. Leaked-password protection — turn it on
**Auth → Policies → Password strength.**

Currently off. Free. Staff sign in with `signInWithPassword`, and (see B1) a password
is currently the *only* thing standing between an attacker and full RLS-authorised
access to all client data.

### A3. Storage bucket privacy — confirm, don't change
**Storage → `client-documents` → Configuration.**

Should be **not public**. The bucket holds client KYC/AML material — ID and
proof-of-address from the portal, CH-code ID/POA, admin-task attachments. The RLS
policies on it are genuinely tight (clients get INSERT only, into their own entity's
folder, and cannot read anything back). But the bucket's `public` flag sits outside
those policies, and one toggle would serve every passport scan with no credential.

The audit now checks this every 15 minutes, so this is a one-off confirmation rather
than something to keep watching.

---

## B. Needs planning, not a quick fix

### B1. Staff MFA is enforced in the browser only
**This is the largest remaining blast radius.**

`src/shell/AppShell.jsx` runs the MFA challenge. `is_active_staff()` — the predicate
every RLS policy gates on — only asks `auth.uid()`. So:

- Talk to `/rest/v1/` directly with a password-only session and the challenge never
  runs. The MFA screen is a UI curtain.
- Staff with **no enrolled factor are never prompted at all**. MFA is opt-in.

Combined with A2, one credential-stuffed staff account is complete read access to 72
clients' financials, every fee, every HMRC position.

The fix is to make `aal2` part of the predicate rather than the UI:

```sql
create or replace function public.is_active_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_profiles where id = auth.uid() and is_active)
     and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;
```

**Do not just run that.** Sequence it, or you lock the firm out:
1. Enrol all 11 active staff in MFA first, and confirm each one.
2. Keep `is_staff_or_service()` passing `service_role` and no-JWT callers, or every
   cron and edge function breaks.
3. Decide what `src/lib/trustedDevice.js` (a 90-day aal1 bypass) means server-side —
   as written, an aal2 requirement would defeat it and people would be prompted every
   time, or you need a server-side notion of a trusted device.

This is the same mistake as the 2026-08-18 findings, one layer up: a check above the
data layer means nothing when the predicate below it does not ask.

### B2. The `portal-dashboard` edge function and `sql/238`
Queued as a task. The client-dashboard workstream added a new edge function and
migration during the security work, and they are the only part of today's surface not
reviewed. A new edge function is exactly the class we spent the day on.

Note it appears to be **portal-facing**, so the right check is *not* plain staff — it
must scope every read to the caller's own `entity_memberships`. `portal_my_dashboards()`
already exists in the database and is exempted in the audit as self-scoped.

---

## C. Code work, ranked

1. **`reconcile_field_overrides()`** — any active staff member can write *any* column on
   `entities` through it, including fee columns they are not allowed to read, and it
   reads in the audit trail as a routine BM reconciliation. Its sibling
   `admin_tasks_confirm_from_bm()` already constrains the column against
   `information_schema`; this one does not. Verified by reading both.

2. **`sql/170_rollback.sql`** — a file in the repo whose own header warns it re-opens
   ~10k rows to `anon` and restores anon-callable destructive RPCs. Pasting it into the
   SQL editor trips no gate. `sql/228`–`233` supersede it. Rename it
   `DO_NOT_APPLY_*`, move it to `docs/`, or delete it.

3. **`_shared/accept-token.ts`** — signs client-facing quote-accept tokens with
   `SUPABASE_SERVICE_ROLE_KEY`. Three problems: it couples a low-value token's
   forgeability to the highest-value credential; rotating that key silently invalidates
   every quote link already in clients' inboxes; and `?? ""` means an unset env var
   yields an empty signing key, under which **any forged token validates** — it fails
   open. Also `EXP_LEEWAY_SECONDS` is 3650 days, so the 120-day expiry is decorative.
   Fix: a dedicated `ACCEPT_TOKEN_SECRET`, fail closed if unset, real expiry. The
   pattern to copy is `_shared/oauth-state.ts`, added today.

4. **`gdrive_connections`** hands plaintext OAuth `access_token`/`refresh_token` to all
   11 staff via `for select using (is_active_staff())`. `gmail_connections` got this
   right in `sql/133` — policy dropped, gated `v_gmail_connections` view exposing only
   non-secret columns. Copy that pattern.

5. **Gate bypasses in `scripts/security-gate.cjs`** — my own tooling, so worth saying
   plainly:
   - `git commit -a` and `git commit <path>` are **invisible** to the classifier: it
     only reads the index via `git diff --cached`, so a working-tree commit assesses as
     empty and passes.
   - The PowerShell idiom this machine mandates — `A; if ($?) { B }` — slips the commit
     matcher, because the `git` is preceded by `{`.
   - `merge`, `revert`, `rebase --continue` and `cherry-pick` create commits without
     running `git commit` at all. `git revert` of the `231` commit would re-open the
     bookkeeping-drift leak with no gate involvement.
   - `pass 0` is an unverified self-attestation: nothing checks the audit actually ran.
   Mitigation for all of it is `sql/240` — the audit now runs every 15 minutes
   regardless of how a change arrived.

6. **Lower, but real** — `telnyx-inbound` never verifies the Ed25519 signature Telnyx
   sends and authenticates on a secret in the *query string*; `portal-send-code` returns
   a distinct 403 vs 200 and so enumerates your client list to any website
   (`Access-Control-Allow-Origin: *`), and its invite check has no revocation or expiry
   predicate; `cron_secret` is a shared bearer readable by all staff from six config
   tables, so a staff member without `can_view_ch_codes` can still invoke
   `ch-code-queue-fill`; `vercel.json` sets no CSP or HSTS while the session lives in
   `localStorage`, so any XSS exfiltrates a staff JWT.

7. **`verify_jwt` is not declared in `config.toml` at all** — it is set at deploy time,
   so it is invisible to code review *and* to the security gate. A function could be
   deployed with the gateway open and nothing in the diff would show it. Worth encoding
   as a `[functions]` block, or a check in the gate.

### Deliberately not doing
- **38 functions with a mutable `search_path`.** The attack needs `CREATE` on a schema
  in the resolution path; on PG15+ `PUBLIC` no longer has it on `public`, and Supabase
  grants it to neither `anon` nor `authenticated`. Latent, not live. It becomes 38
  simultaneous root escalations the moment someone runs
  `grant create on schema public to authenticated` — so don't.
- **Moving `pg_trgm` out of `public`.** Would break every `gin_trgm_ops` index and the
  `similarity()` calls in `sql/027` and `sql/197`. Real cost, no current benefit.

---

## How to check where things stand

```bash
node scripts/security-gate.cjs assess     # is my staged diff security-relevant?
node scripts/security-gate.cjs status     # is a clean audit recorded for it?
```

```sql
select * from public.security_posture_audit();               -- must be zero rows
select * from public.security_posture_findings
  where cleared_at is null;                                  -- what the cron has seen
select * from public.security_audit_exemptions;              -- reviewed-and-accepted, with reasons
```

A finding you have reviewed and accepted goes in `security_audit_exemptions` with a
reason. **Do not loosen the audit's gate regex to make a finding disappear** — that is
how `raise exception` and a bare `auth.uid()` came to count as authorisation, which left
the audit unable to re-find its own founding finding.

---

## Done on 2026-08-19, for context

- `228`–`233` — the Supabase advisor's CRITICAL (two backup tables readable *and
  writable* by `anon`), five `v_bk_*` views serving 72 clients' bookkeeping data to
  `anon`, two unauthenticated writes into the private `hmrc` schema, 13 definer
  functions callable by portal clients, and the `PUBLIC`-grant trap that made the first
  round of revokes a silent no-op. Backups then dropped.
- `234` + `scripts/security-gate.cjs` + a `PreToolUse` hook — the audit and the
  pre-commit gate.
- `235`, `c607c73` — authorisation added to ten edge functions that had none, including
  an open mail relay from `info@`, a no-credential mass QBO disconnect, and a
  chart-of-accounts restructure that ran on a bare `POST {}`. The nightly QBO pull moved
  off the anon key it had hardcoded.
- `83006e7` — `send-uplift-email` deleted (dead code that could send mail as the practice).
- `0f010a1`, `236` — OAuth state signed, single-use, and issuable only to staff, across
  the QBO, Gmail and Drive flows.
- `239`, `240` — the audit's own blind spots fixed (which surfaced the whole `run_*`
  cron family being callable by any logged-in user), and it now runs every 15 minutes.
