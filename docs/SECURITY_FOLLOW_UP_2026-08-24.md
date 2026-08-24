# Security follow-up — as at 2026-08-24

Supersedes [SECURITY_FOLLOW_UP_2026-08-19.md](SECURITY_FOLLOW_UP_2026-08-19.md). Items
carried forward from that list are marked **(carried)** with their original reference,
so nothing is lost by reading only this file.

This review was prompted by an external IT adviser flagging three things: that
Supabase holds AVA's QuickBooks token, that it holds Companies House authentication
codes we do not use, and that the estate is not behind a VPC. All three were checked.
Two were right and are now fixed or scoped; the third is real but ranks last.

Method matters here. Every reachability claim below was tested by impersonating the
role — `anon`, an `authenticated` user with no staff row, and an active non-admin staff
member — inside transactions that were rolled back. Querying as `postgres` proves
nothing: it bypasses RLS, so an ungated definer view looks identical to a gated one.
That is precisely how five views went unnoticed while serving 72 clients' bookkeeping
data to `anon` in August.

`select * from public.security_posture_audit();` returns **zero rows** as at this date.

---

## What the review found, in one table

| | Verdict |
|---|---|
| Public perimeter (`anon`) | **Clean.** 0 of 74 views readable; every secret table refuses outright — the gate functions are not even executable by `anon`, so it gets a permission error rather than an empty set. |
| Portal clients (`authenticated`, no staff row) | **Clean.** 0 rows from `entities`, `qbo_connections`, `reminder_emails`, and all six definer views that carry no local predicate. |
| Client QuickBooks tokens (131) | **Protected.** `qbo_report_tokens` has RLS on and zero policies — the safest possible state. Unreachable from any staff or client session. |
| AVA's own QuickBooks token | **Was readable by all 11 staff.** Fixed — sql/256. |
| Companies House auth codes (273) | **Was held with no operational use.** Fixed — sql/257. |
| `merge_person` | **Was ungated, destructive, callable by any portal client.** Fixed — sql/256. |

---

## Fixed on 2026-08-24

### sql/256 — authorisation, and secrets out of staff reach

`merge_person` was `SECURITY DEFINER`, granted to `authenticated`, with no permission
check anywhere in its body — and portal clients hold `authenticated` alongside staff,
so a signed-in client could call `/rest/v1/rpc/merge_person` and delete from `people`,
`ch_code_requests` and `entity_people`. It now opens with `is_staff_or_service()`.

Three BM-person functions (`import_bm_people`, `apply_bm_person_merges`,
`set_bm_person_merge_verdict`) carried an `anon` EXECUTE grant. They refuse
unauthorised callers internally, so nothing leaked, but the grant was one edit away
from being the only thing standing there. Revoked, from `public` as well as `anon` —
had the grant belonged to `PUBLIC` the named revoke would have been a silent no-op.

Every secret table had RLS on, but the ones added earliest inherited a blanket
`is_active_staff()` read with no column restriction. So the policy letting staff see
*whether* QuickBooks is connected also handed them the refresh token. All 11 active
staff could read AVA's own QBO tokens, the Drive refresh token, 190 portal magic-link
tokens (`reminder_emails.token` — enough to act as that client in the reminders and
opt-in flows) and a cron secret. None are consumed by a browser; edge functions read
them as `service_role`, which bypasses all of it.

Mechanically: Postgres will not let you revoke a *column* from a role holding
table-level SELECT — column privileges are additive on top. The only way to withhold
one column is to revoke SELECT on the table and grant it back column by column. Hence
the verbose grant lists in the migration.

Also blanked the credential on the dormant `qbo_connections` row: disconnected since
21 July, unreachable by `qbo-push` (which selects `status='active'` with `.single()`),
and still holding a refresh token valid to 30 October.

### sql/257 — Companies House codes become a flag

273 of 667 entities held what read as real codes: 267 distinct, none matching the
`-2223` placeholder pattern.

A code plus a company number is a filing credential — it files as that company on
WebFiling: registered office, appointments, terminations, accounts. Unlike a
QuickBooks token **we cannot revoke it**; only the company can, by requesting a new one
posted to the registered office. A breach touching these would be hard to characterise
as low risk to the data subjects, which points at Article 34 notification, and the
remediation would not be ours to perform.

The value was never used. Every consumer tests only presence. So values collapse to the
literal `'held'`, which every presence test reads identically, and no view needed
rewriting. BrightManager remains the system of record.

Enforcement is a `before insert or update` trigger on `entities`, not an edit to
`import_bm_clients` — it covers every write path rather than the one we happen to know
about, and it left the import function alone while that workstream is mid-change.
A one-off `DELETE` would have been undone by the next BM import; this is not. Behind
the trigger sits a CHECK constraint that is unreachable while the trigger stands,
deliberately: drop the trigger and the constraint still refuses a real code. Both were
verified — writing `AB12CD` stores `'held'`, and with the trigger disabled the same
write is refused.

---

## A. Yours — Supabase dashboard

### A1. Allowed Redirect URLs — **CLOSED 2026-08-24, and it was a real hole**
Open since 19 August. There was no wildcard and no localhost entry — but the allow-list
carried `https://athena-portal-build.vercel.app/**`, which **is not a domain we own**.
It is absent from the Vercel alias list and returns `404 DEPLOYMENT_NOT_FOUND`. It
matched the local folder name, not the project name (`athena-portal`).

The chain: the Supabase auth endpoints accept a `redirect_to` parameter and the anon key
is public, so anyone could trigger password recovery for a known staff email with
`redirect_to=https://athena-portal-build.vercel.app/login`. It matched the allow-list, so
the recovery link in a genuine Supabase email would point at a host we do not control —
and whoever claimed that Vercel project name would receive the token. Full staff-account
takeover, and staff see every client's financials.

Removed. The two remaining entries are the real production domains:
`portal.almondvalleyaccounting.co.uk` (project `athena-portal`) and
`clients.almondvalleyaccounting.co.uk` (project `athena-client-portal`).

Lesson worth keeping: a redirect allow-list needs checking for *unowned* hosts, not just
for wildcards. A dangling entry is a wildcard with extra steps.

### A2. Leaked-password protection — **CLOSED 2026-08-24**
On. Verified from here: the `auth_leaked_password_protection` lint has gone from the
advisor set. Minimum length also raised to 8 with upper, lower and symbol required.

### A2b. Public signup disabled — **CLOSED 2026-08-24, new**
"Allow new users to sign up" was **on**. No UI offered it — `src/pages/LoginPage.jsx` has
a Create Account form but is dead code, since `main.jsx` routes `shell/LoginPage`. That
is irrelevant: the anon key is public, so while the setting was on anyone on the internet
could POST `/auth/v1/signup` and mint themselves an `authenticated` account. That is the
role holding EXECUTE on the definer functions and the table grants RLS gates — the
difference between `merge_person` being reachable by an invited client and by anybody.

Nothing depended on it. Staff come from `invite-user` → `auth.admin.createUser`; portal
clients from `portal-send-code` → `admin.createUser` + `admin.generateLink`. Both use the
admin API, which the toggle does not govern.

Follow-on, not done: delete `src/pages/LoginPage.jsx`. A working Create Account form in
the repo is one stray import from re-opening the door.

### A3. Storage bucket privacy — **(carried, now closed)**
The audit's `storage_bucket_public` check returns zero rows, and `storage.objects` RLS
is on. Nothing to do.

### A4. Network restrictions — **new**
The sane version of the VPC instinct: restrict the direct Postgres port to known IPs.
It removes credential-stuffing and scanning against port 5432. It does **not** touch
the REST API path, which is where every finding in this review and the entire August
incident travelled — so do it, but do not expect it to change the risk ranking. See
"On the VPC question" below.

### A5. Rotate `service_role`, and write down every copy — **new**
The single largest point of total failure. That one string bypasses RLS entirely: with
it, every control in this document evaporates — all 131 client QuickBooks tokens, all
the Companies House flags, every client's financials, in one request from any machine.
It lives in edge-function environments, in Vercel's environment, and in local tooling
config. Rotation is cheap; the real deliverable is knowing where all the copies are.

---

## B. Needs a decision

### B1. Staff MFA — **client half fixed 2026-08-24, database half prepared**

This was worse than the 19 August note said, and the measurement is the point.

`is_active_staff()` — the predicate behind 402 RLS policies — only asked `auth.uid()`.
So a password-only session talking straight to `/rest/v1/` never met a challenge; the
MFA screen in `AppShell.jsx` was a curtain, not a control. Same mistake as the
2026-08-18 findings, one layer up: a check above the data layer means nothing when the
predicate below it does not ask.

But the client side was not working either. `MFAChallenge.jsx` had **"Remember this
device for 90 days" ticked by default**, and `AppShell` short-circuited to `ok` whenever
a matching `mfa_trusted_devices` row existed. So after one sign-in nobody ever completed
a challenge again. Measured on 24 August:

| | |
|---|---|
| Active staff holding a verified TOTP factor | 10 of 11 |
| Live trusted-device rows (to 2026-11-17) | 17 |
| Sessions at `aal2` | **0 of 10** |

Zero. The firm had enrolled MFA and was not using it.

**Fixed on the client:** the device bypass is gone — `AppShell` now always challenges an
`aal1` session that has a factor, and the checkbox is removed. `aal` is a property of
`auth.sessions` and survives token refresh, so the cost is one prompt per fresh sign-in,
which is what MFA means. This is why the bypass was not reimplemented server-side: it
was never buying convenience worth the price, and putting a device token in a header
would have made it a second bearer credential.

**Prepared, not applied:** [sql/258_mfa_aal2_required.sql.PREPARED](../sql/258_mfa_aal2_required.sql.PREPARED)
adds the `aal2` test to `is_active_staff()`. It carries its own go-live checklist. Do
not apply it before that checklist is complete — it is the highest-blast-radius function
in the database, and applying it early locks out all eleven staff rather than fixing an
exposure. `is_staff_or_service()` is deliberately unchanged, which is what keeps the 25
cron jobs and 67 edge functions running.

**The one blocker that needs a person, not code:** `ryan@tapee.io` is an active staff
row with no MFA factor at all and last signed in 2026-04-16. Enrol them or set
`is_active = false`. A four-month-dormant active account with no second factor is a
finding on its own, and deactivating is the cheaper answer if they are no longer
involved.

The gate before applying, which is checkable rather than a judgement:

```sql
select count(*) filter (where s.aal = 'aal2')  as elevated,
       count(*) filter (where s.aal <> 'aal2') as still_aal1
from auth.sessions s
join public.staff_profiles sp on sp.id = s.user_id
where sp.is_active;
```

`still_aal1` must be 0.

### B2. `portal-dashboard` edge function and `sql/238` — **(carried)**
Still the only part of the August surface never reviewed. Portal-facing, so the right
check is not plain staff — it must scope every read to the caller's own
`entity_memberships`.

### B3. One Companies House code still sits in `admin_tasks` — **new**
`admin_task_from_extract` maps a `companies_house_letter` extraction to the
`ch_auth_code` field, and one open task (stage `todo`) holds an extracted code in
`admin_tasks.value`. This is a *transient* holding with a real purpose — someone needs
it to type into BrightManager — as opposed to the 273-row permanent store now gone.

Not purged unilaterally, because doing so destroys in-flight work: whoever owns that
task would have to re-read the letter. Two options: clear it and accept the rework, or
add a rule that clears `value` when a `ch_auth_code` task leaves `todo`, so codes never
accumulate. The second is better and is a small change. There is no accumulation
problem today — this is the only such row.

---

## C. Deliberately not doing, with reasons

### C0. Two access decisions taken on 2026-08-24, on the record

**`ryan@tapee.io` stays active and unenrolled.** Bobby's call, and it does not block the
MFA work: he holds **0 sessions**, so he cannot hold the `still_aal1` gate open. Once
sql/258 is applied the requirement enforces itself — signing in with no factor lands him
on the app's enrolment screen, and the database refuses him until he completes it. So the
residual is narrow: an active staff row, dormant since 2026-04-16, that grants nothing
until someone authenticates it properly. Revisit if he is not coming back.

**The three non-staff test accounts stay.** `bobbygallacher@hotmail.com`,
`stephm10@hotmail.co.uk`, `ryanfindlayy@gmail.com` — portal tests, each created and used
once in July. They are `authenticated` identities with passwords and no MFA. Tested
reachability for exactly this shape of account: 0 rows from `entities`,
`qbo_connections`, `reminder_emails` and every ungated-looking definer view. With public
signup now off they also cannot be joined by new ones. Accepted.


### C1. The 38 `function_search_path_mutable` warnings
Not sweeping these blind. The exploit requires an attacker to create a shadowing object
in a schema earlier in the path, and **no API role can CREATE in `public`** — verified:
the ACL grants `anon`, `authenticated` and `service_role` `USAGE` only. So the warning
is not reachable by the roles that matter.

Against that, a blind `set search_path = public` sweep would break any function calling
`net.*` (pg_net, used by the cron jobs) or `extensions.*` unqualified. Trading 25 live
cron jobs against a non-exploitable lint is a bad trade. Worth doing per-function when
those functions are touched for other reasons.

### C2. The 50 `security_definer_view` ERRORs in the dashboard
These are shape warnings, not exposure. Tested: 0 are readable by `anon`; 44 carry
their own predicate; the 6 with no local predicate
(`v_hmrc_client_totals`, `v_hmrc_ct_by_client`, `v_hmrc_vat_by_client`,
`v_hmrc_sa_by_client`, `v_hmrc_paye_trend_monthly`,
`v_onboarding_crosscheck_coverage`) inherit one from the gated view beneath them, and
all six returned 0 rows to a portal client.

Note the inversion, because it will recur: the dashboard's red ERRORs were all clean,
while its amber `authenticated_security_definer_function_executable` warnings — 112 of
them — contained the one genuinely missing check in the estate. **Trust
`security_posture_audit()` over the dashboard.** It tests reachability; the dashboard
tests shape.

### C3. Migrating the estate to GCP behind a VPC
Assessed and declined for now — see below.

---

## On the VPC question

"Everything behind a VPC" is not achievable while there is a client portal: the
frontend serves clients over the public internet by definition. What is achievable is
three-tier — static frontend on a CDN, backend API inside the VPC, Postgres with a
private IP and no public endpoint.

What that genuinely buys: the database stops being internet-reachable; authorisation
moves out of 402 RLS policies and 163 definer functions into application code that can
be unit-tested and gated in CI; secrets move to a managed secret store; and
`service_role` is replaced by a service account issuing short-lived tokens.

What it does not buy: the Companies House problem was *holding data we did not need* —
identical in any cloud. The `merge_person` bug class moves rather than vanishes; a
route missing its auth middleware is the same defect, and arguably easier to ship
because there is no RLS backstop underneath. And we would lose the instrumentation
built here — `security_posture_audit()`, the pre-commit gate, the 15-minute cron audit
— which has no GCP equivalent out of the box.

The cost, measured rather than guessed: **499 `.from()` and 87 `.rpc()` call sites**
across **225 distinct tables/views and 75 RPCs**, plus 228 tables, 402 policies, 356
frontend files / 122k lines, 67 edge functions, 25 `pg_cron` jobs and 314 migrations.
Every one of those call sites needs its authorisation re-expressed in backend code. The
migration window is itself the highest-risk period, because that is when authorisation
gets reimplemented under time pressure.

Ranked honestly, exposure is: (1) handling of the `service_role` key, (2) compromise of
one staff login, (3) application authorisation defects, (4) holding data we do not
need, (5) the network path to the database. A VPC addresses only (5).

**Revisit if** we start hiring developers — RLS-as-authorisation does not scale across
a team, and that is the strongest argument for the move — or if a client or insurer
contractually requires private networking.

---

## The incremental path instead

One rule, which is now in CLAUDE.md: **new mutations go through an edge function, not a
browser table write.** There are already 67 edge functions, so the pattern exists. Each
one moved shrinks the browser's grants toward read-only, which is most of the
three-tier benefit without a rewrite and without a migration window.

---

## If there is ever a breach — the first 72 hours

Written down because Article 33 gives 72 hours from *becoming aware*, and that clock is
not long enough to also be deciding who does what.

**Hour 0–1 — stop the bleeding.**
Rotate `service_role` and the anon/publishable key in the Supabase dashboard. Revoke
active sessions (Auth → Users). If a staff account is implicated, disable it and set
`is_active = false` on `staff_profiles`. If QuickBooks is implicated, disconnect the
app from within QuickBooks itself — revoking there kills the refresh token, which
rotating our keys does not.

**Hour 1–8 — establish scope, in writing.**
What data, whose data, how many people, over what window. Postgres logs and Cloud audit
history are the evidence. Record what you *cannot* determine as well as what you can —
"unable to establish" is an acceptable answer to the ICO; a guess is not.

**Hour 8–24 — decide notification.**
Article 33: notify the ICO within 72 hours unless the breach is unlikely to result in
risk to individuals. Article 34: notify affected individuals too if the risk is high.
Companies House codes are no longer held, which materially lowers this — that was the
one category where "unlikely to result in risk" would have been indefensible.

**Hour 24–72 — file, and tell people.**
ICO report if warranted (they have an online form; keep the reference). Then clients,
and your professional body and PII insurer per their notification conditions — check
those conditions *now*, not on the day; late notification is a more common cause of a
declined claim than the incident.

**Standing:** the person who discovers it writes the timeline as they go. The single
most valuable artefact after an incident is a contemporaneous log, and it is impossible
to reconstruct afterwards.

---

## How to check where things stand

```sql
select * from public.security_posture_audit();
```

Zero rows or it is not clean. A finding you have reviewed and accepted goes in
`security_audit_exemptions` with a reason — bound to a hash of the function definition,
so editing an exempted function re-flags it rather than silently inheriting the old
judgement. `sql/240` re-runs the same audit every 15 minutes via `pg_cron` and notifies
`can_manage_portal`. It shows in `/admin/schedules` as "Security posture audit".

Reachability, which the static audit cannot see:

```sql
begin;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"<uuid>"}', true);
set local role authenticated;
select count(*) from <thing>;
rollback;
```

Run it as a portal-client `sub` (expect 0) and an active-staff `sub` (expect the
numbers staff saw before the change). Never as `postgres`.

---

## Also worth knowing

The `av-periodic-review` Supabase project is **paused, not deleted**. A paused project
still holds its data, and it sits outside every control described in this document.
Either delete it or bring it into scope.
