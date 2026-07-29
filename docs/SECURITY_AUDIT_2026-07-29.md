# Athena — Security Audit, 29 July 2026

Scope: `athena-portal-build` (staff app), `client-portal`, 57 Supabase edge
functions, live Postgres (RLS, grants, SECURITY DEFINER surface), git history,
dependencies.

Method: static review plus **live probing of the production database as the
`anon` and `authenticated` roles** — every finding below marked CONFIRMED was
reproduced, not inferred.

---

## Executive summary

**Keys: clean.** No secret has ever been committed. `.env` is gitignored and
absent from all history; no service-role key, OAuth client secret, or provider
API key appears in tracked files. Tokens (Gmail/QBO/Drive refresh tokens,
Telnyx and Clerk API keys) live in DB tables gated to `is_portal_admin()`, or
in Supabase Vault. MFA trusted-device tokens are stored SHA-256 hashed, raw
token client-side only — correct design.

**RLS on base tables: sound.** Probed as `anon`: `entities`, `people`,
`staff_profiles`, `live_billing`, `recruitment_applications`,
`gmail_connections` all return **0 rows**. Client-portal isolation is correct —
every portal-facing table scopes through `entity_memberships` /
`my_entity_ids()`.

**Edge functions: mostly well built.** Of 35 functions running
`verify_jwt = false`, nearly all carry a correct in-function guard
(`getUser()` + `staff_profiles` check, an `x-cron-secret` match, or an
unguessable token). `resend-webhook` does real Svix HMAC verification;
`comm-click` uses a server-side destination allowlist instead of a
caller-supplied URL; the email-body iframes use `sandbox="allow-same-origin"`
*without* `allow-scripts`, so untrusted inbound client email cannot execute
script. No `eval` / `new Function` anywhere; the forecast expression evaluator
is a hand-written parser.

**The problem is the layer that sits outside RLS.** Postgres defaults —
`SECURITY DEFINER` views and `EXECUTE` to `PUBLIC` on functions — opened a
path that the public anon key reaches directly. This is the one finding that
needs acting on today.

---

## HIGH — 1. Unauthenticated read of live client data via SECURITY DEFINER views

**CONFIRMED.** Reproduced by executing `SET ROLE anon` and selecting.

Twelve views were created with the pre-15 `SECURITY DEFINER` default, so they
read their base tables **as the view owner** and RLS never applies. `anon`
held `SELECT` on eleven of them. The anon key is public by design — it ships
in the Vite bundle, so this needs no credential at all.

Rows returned to an unauthenticated caller:

| View | Rows | Contents |
|---|---|---|
| `bm_task_schedule_with_progress` | 2,034 | full job schedule — client, service, deadlines, assignee, hours |
| `v_bm_load_classified` | 1,954 | per-client service load by assignee/month |
| `v_client_group_pairs` | 1,779 | person → entity relationship graph, with names |
| `v_client_group_links` | 1,115 | entity ↔ person links, with names |
| `v_inferred_allocations` | 915 | client → service → assignee |
| `v_service_cadence` | 909 | per-client service cadence |
| `v_email_reconciliation` | 640 | **client names + contact emails + QBO billing emails** (630 with an email present) |
| `v_client_groups` | 626 | client group structures + labelling person |
| `v_capacity_load_monthly` | 264 | staff capacity/load |
| `v_reminder_autoqueue`, `v_bug_review_config` | 1 each | config flags |

`v_gmail_connections` was the one exception — no anon `SELECT` grant.

**Impact.** Unauthenticated disclosure of the client list, client contact
email addresses, and the director/officer relationship graph. This is personal
data under UK GDPR; treat as a reportable exposure pending a decision on
whether it was ever accessed (see *Next steps*).

**Fix.** `sql/170_security_hardening.sql` §1 — `security_invoker = true` on all
twelve, plus `REVOKE SELECT … FROM anon`. All twelve are staff-side surfaces;
no client-portal flow reads them, so no portal behaviour depends on the RLS
bypass.

---

## HIGH — 2. Unauthenticated client-directory enumeration via `search_entities_for_wizard`

**CONFIRMED.** `SET ROLE anon; SELECT * FROM search_entities_for_wizard('a', 5)`
→ 5 rows.

`SECURITY DEFINER`, no caller check, `EXECUTE` to `PUBLIC`. Returns
`id, name, type, bm_client_id, company_number, entity_status`, and a blank
query returns everything — 50 rows a call, paginable to the full 661-entity
book.

Only caller is `src/modules/data-import/views/ImportView.jsx:1618`, a staff
module, so gating on `is_active_staff()` costs nothing.

**Fix.** §2 (revoke anon EXECUTE) and §3 (`is_active_staff()` in the `WHERE`,
matching the pattern already used by `onboarding_quote_for_entity`).

---

## HIGH — 3. Unauthenticated destructive RPCs: `merge_people`, `merge_person`, `dedupe_*`

**CONFIRMED.** `SET ROLE anon; SELECT merge_people(<uuid>, <uuid>)` executed
with no permission error.

Four `SECURITY DEFINER` functions with **no caller check** and `EXECUTE` to
`PUBLIC`:

- `merge_people(source, target)` — `DELETE FROM people`, rewires
  `entity_people` and `entities.linked_person_id`
- `merge_person(target, source)` — same plus `ch_code_requests` collapse
- `dedupe_people_by_code(p_dry boolean)` — **needs no UUIDs**. Called as
  `dedupe_people_by_code(false)` it walks every duplicate `ch_personal_code`
  group in `people` and merges/deletes across the whole table.
- `dedupe_ch_clusters(p_dry boolean)` — same shape

`dedupe_people_by_code(false)` is the sharp one: a single unauthenticated call
with a public key causes bulk, irreversible deletion of person records. No
enumeration step needed.

Also unguarded and anon-callable, lower blast radius: `confirm_wont_happen_tasks`,
`raise_person_dedup_tasks`, `reconcile_allocation_changes`,
`reconcile_field_overrides`, `reconcile_qbo_sync_responses`,
`reconcile_ready_now_change_requests`, `triage_from_ch_status_event`.

**Fix.** §2 + §3.

---

## MEDIUM — 4. Unauthenticated triggering of client-facing email and SMS

**CONFIRMED anon-executable** (not fired — these send real messages to real
clients).

The whole `run_*` family is `SECURITY DEFINER`, unguarded, `EXECUTE` to
`PUBLIC`: `run_onboarding_chase`, `run_onboarding_checkin`,
`run_onboarding_weekly`, `run_ch_code_chase`, `run_ch_code_calls`,
`run_ch_code_queue_fill`, `run_ch_code_weekly`, `run_reminders_autoqueue`,
`run_deadline_digest`, `run_athena_reminder`, `run_job_review_chase`,
`run_job_review_monthly`, `run_comms_ingest`, `run_chase_reply_scan`,
`run_notification_sweep`, `run_bug_review_digest`, `run_qbo_pull_nightly`,
`run_ch_refresh_chunk`, `run_ch_refresh_report`, `trigger_qbo_monthly_pull`.

Each reads a `cron_secret` from its config table and `net.http_post`s the
matching edge function. The edge functions themselves are correctly guarded —
but these wrappers hold the secret, so calling the wrapper *is* the bypass.
An unauthenticated caller can drive client chasers and digests on demand
(reputational damage, Resend/Telnyx spend, and for
`trigger_qbo_monthly_pull` a service-role-authenticated call out of Vault).

The secret never leaks to the caller, and the edge functions are idempotent
enough that this is abuse rather than compromise — hence MEDIUM.

**Fix.** §2 revokes anon EXECUTE across the family. pg_cron is unaffected:
all 18 jobs run as `postgres`, which owns the functions.

---

## MEDIUM — 5. No CSRF state validation on the Gmail and QBO OAuth callbacks

`gmail-auth-init`, `gmail-auth-callback`, `qbo-auth` all run
`verify_jwt = false` with **no authentication and no state binding**.

`state` is plain base64 JSON built from unvalidated query params
(`staff_id`, `user_id`, `return_to`, `kind`, `set_default`), never signed,
never stored, never compared on return
(`supabase/functions/gmail-auth-callback/index.ts` decodes it inside a
`try {} catch { /* tolerate malformed state */ }`).

Two consequences:

1. **Attribution forgery** — anyone can set `staff_id` to any staff UUID, so
   `gmail_connections.connected_by` and the `audit_log` row are
   caller-controlled.
2. **Practice-default mailbox takeover** — `gmail-auth-callback` will insert a
   `gmail_connections` row and, when `set_default` is set, clear the existing
   `is_practice_default` and point it at the new row. An attacker who can
   complete a Google consent for the AVA OAuth app would redirect the firm's
   automated outbound client email through their own mailbox. **This is gated
   by the Google Cloud consent screen**: if the app is Internal/org-restricted,
   only `almondvalleyaccounting.co.uk` accounts can consent and the practical
   risk is low. Worth confirming that setting — it is the only thing standing
   in the way.

`return_to` is checked for a leading `/` and concatenated onto `PORTAL_BASE`,
so it is not an open redirect.

**Fix (not in migration — edge-function work).** Sign the state (HMAC with a
dedicated secret) or persist a single-use nonce, verify it on callback, and
reject on mismatch. Derive `staff_id` from a verified session rather than a
query param. Confirm the Google app's publishing status.

---

## MEDIUM — 6. `staff_profiles` readable by every authenticated user

Policy `"Authenticated users can read staff_profiles"` is
`USING (auth.role() = 'authenticated')`. Policies are permissive and OR'd, so
this defeats the four narrower policies alongside it.

Client-portal users are genuine Supabase auth users — `portal-send-code`
calls `admin.createUser` and the portal completes `verifyOtp` for a real
session. So **every client with portal access can read all staff rows**:
names, emails, and the full permission-flag set (`can_view_client_fees`,
`is_portal_admin`, `can_manage_task_pipeline`, …). That flag set is also a map
of who to target.

**Fix.** Drop that policy and replace with one scoped to staff:
`USING (is_active_staff() OR id = auth.uid())`. Check first that no portal
screen reads staff names from this table — if one does, expose a names-only
view to portal users, as already done for onboarding fee confidentiality.

---

## MEDIUM — 7. Dependency vulnerabilities (6 high)

`npm audit`: 6 high, 1 moderate, 1 low.

| Package | Where | Issue | Fix |
|---|---|---|---|
| `react-router-dom` 7.14.0 → `react-router` | **prod** | vendored turbo-stream allows arbitrary constructor invocation via `TYPE_ERROR` deserialization (unauth RCE) | version bump available |
| `xlsx` 0.18.5 | **prod** | prototype pollution + ReDoS | **no npm fix** — 0.18.5 is the last registry release; fixed only in SheetJS's own CDN builds |
| `ws` 8.20.0 (via `@supabase/supabase-js`) | **prod** | uninitialised memory disclosure, memory-exhaustion DoS | bump `supabase-js` |
| `dompurify` 3.3.3 (via `jspdf`) | **prod** | `FORBID_TAGS` bypass | bump `jspdf` |
| `vite` 6.4.2 | dev | `server.fs.deny` bypass on Windows alternate paths | bump |
| `postcss` | dev | XSS via unescaped `</style>`, arbitrary file read | bump |

`xlsx` is the one needing a decision: it parses uploaded spreadsheets
(BM/TaxCalc imports), so the ReDoS and prototype-pollution paths are
reachable from file content. Options are switching to the SheetJS CDN tarball,
moving to `exceljs`, or accepting it on the basis that only staff upload files.

React Router is a straightforward bump; verify against a Vercel build before
merging, since a failed build freezes prod.

---

## LOW — 8. Client-email enumeration and email-bombing via `portal-send-code`

`supabase/functions/portal-send-code/index.ts`:

- Returns **403 with a distinct message** for an address not in
  `client_portal_invites`, versus 200 for one that is — a clean oracle for
  "is this person an AVA portal client".
- Throttle is a **30-second cooldown per email only**. `send_count` is
  incremented but never enforced, so an invited client's inbox can be driven
  at ~2 emails/minute indefinitely — on the firm's warmed Resend domain, which
  risks the sending reputation as much as the recipient.
- The minted OTP is **valid for one hour**. Six digits over a one-hour window
  leans harder on Supabase's own verify rate limits than it needs to.

**Fix.** Return an identical 200 in both branches; add a daily cap on
`send_count` alongside the cooldown; shorten OTP expiry to 10–15 minutes in
Supabase Auth settings.

---

## LOW — 9. Assorted hardening

- **Anon key committed in `sql/125_qbo_pull_nightly.sql:21-22`.** Publishable
  by design, so not a leak — but it hardcodes a key with a 2036 expiry into
  git, which makes rotation a code change. Prefer a Vault lookup like
  `trigger_qbo_monthly_pull` already does.
- **Accept tokens are HMAC'd with `SUPABASE_SERVICE_ROLE_KEY`**
  (`_shared/accept-token.ts`). Works, but reuses an authentication credential
  as a signing key — rotating the service key silently invalidates every quote
  link in clients' inboxes. Use a dedicated `ACCEPT_TOKEN_SECRET`.
- **`EXP_LEEWAY_SECONDS = ~10 years`** in the same file effectively disables
  the JWT's own expiry. Deliberate and documented, and `valid_until` is
  enforced server-side — but it means a leaked link stays signature-valid
  forever. Consider narrowing once the Neon Fizz case is behind you.
- **`telnyx-inbound` authenticates via `?secret=` in the query string.**
  Query params land in access logs and proxy logs. Move to a header.
- **Secret comparisons use `!==`** (`clerk-inbound`, `reminders-autoqueue`,
  and the other cron-secret checks) rather than a constant-time compare.
  Low practical risk over HTTPS; cheap to fix.
- **`comm_preference_events` policy is `USING (true)`.** It returns 0 rows to
  anon today only because anon lacks the table-level `GRANT` — the policy
  itself is wide open. 69 rows currently. Tighten to `is_active_staff()`.
- **`clerk_config`, `telnyx_config`, `qbo_report_tokens`,
  `portal_login_attempts`** have RLS enabled with **no policies** — correctly
  closed to everything but service-role. Intentional; noted so it isn't
  "fixed" later by adding a policy.
- **`tg_completed_tasks_audit_delete_fn`** is the one `SECURITY DEFINER`
  function with a mutable `search_path`. It's a trigger function; §2 revokes
  direct EXECUTE, and it should also get `SET search_path`.
- **`pg_net` and `pg_trgm` are installed in `public`.** Supabase advisory;
  low priority, awkward to move now.
- **Supabase Auth: leaked-password protection is off.** One toggle — enables
  HaveIBeenPwned checks on staff passwords.
- **`Access-Control-Allow-Origin: "*"` on most edge functions.** Harmless
  where auth is a bearer token or a secret header (no cookies involved), but
  worth narrowing to the portal origins on the staff-authenticated ones.

---

## Next steps, in order

1. **Apply `sql/170_security_hardening.sql`.** Closes findings 1–4. Sections
   1 and 2 are privilege-only and reversible; §3 rewrites
   `search_entities_for_wizard` and `merge_people` with guards. Verification
   queries are at the foot of the file.
2. **Decide on the disclosure question for finding 1.** Supabase logs
   (`postgrest` request logs) will show whether any anon-role request ever hit
   those view paths from outside the app. Worth pulling before the retention
   window closes — it's the difference between "exposed" and "accessed".
3. **Fix finding 6** (`staff_profiles` policy) — small, and it currently leaks
   the permission model to every client.
4. **Bump `react-router-dom` and `@supabase/supabase-js`**, verify on Vercel,
   and decide what to do about `xlsx`.
5. **Sign the OAuth state** in `gmail-auth-init`/`callback` and `qbo-auth`,
   and confirm the Google app's consent-screen publishing status.
6. **Harden `portal-send-code`** — identical responses, daily send cap,
   shorter OTP.

---

## What was checked and found clean

- No secrets in tracked files or anywhere in git history; `.env` never committed
- No service-role key in any client bundle; frontend uses the anon key only
- RLS enabled on every public table; base-table reads by `anon` return 0 rows
- Client-portal tenant isolation via `entity_memberships` / `my_entity_ids()`
- Token/credential tables gated to `is_portal_admin()`
- MFA trusted devices: hashed at rest, raw token client-side only, 90-day expiry
- `resend-webhook` Svix HMAC verification, including timestamp window
- `comm-click` server-side redirect allowlist — not an open redirect
- `comm-optin` token-as-auth with service-role lookup
- `delete-user`, `invite-user`, `sms-send`, `reminders-send`,
  `drive-save-documents`, `recruitment-email`, `trigger-report`,
  `admin-task-escalate` — all correctly check `getUser()` + a
  `staff_profiles` permission flag despite `verify_jwt = false`
- Email-body iframes: `sandbox="allow-same-origin"` with no `allow-scripts`,
  so untrusted inbound email cannot execute script
- No `eval` / `new Function` / `document.write`; forecast `expr.js` is a real parser
- The three `dangerouslySetInnerHTML` uses render admin-authored templates
  with interpolated variables HTML-escaped (`reminders/lib.js:186`)
- 79 of 93 `authenticated`-executable SECURITY DEFINER functions carry a real
  caller check; only `admin_tasks_confirm_from_bm` and
  `portal_service_catalogue` are unguarded, and both are low-impact
