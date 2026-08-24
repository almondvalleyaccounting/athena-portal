# Athena — working notes

## Security gate (mandatory)

Athena holds live client financial data. Every exposure found on 2026-08-18 was
reachable from the public internet with nothing but the anon key that ships in the
frontend bundle, and not one of them was visible in the RLS policies a reviewer
would read. They were in grants, `SECURITY DEFINER` flags and `PUBLIC` ACLs.

So exposure is checked mechanically, before the commit, not reviewed by eye after it.

### The rule

**A commit that touches an exposure surface does not land until the posture audit
returns zero rows.** Not "returns rows we can explain" — zero.

Exposure surface means any of: a migration under `sql/`, an edge function, anything
under `client-portal/`, or a diff that adds a view, a function, a table, a `GRANT`,
a `REVOKE`, an RLS policy, an RLS toggle, an `.rpc()` call, or a reference to
`anon` / `service_role`. `scripts/security-gate.cjs` decides this, not judgement:

```bash
node scripts/security-gate.cjs assess
```

A `PreToolUse` hook runs `security-gate.cjs gate` on every shell call and blocks the
commit if the staged diff is security-relevant and unaudited. The hook lives in
`.claude/settings.json`, which is gitignored — so on a fresh clone the hook is absent
and **this document is the rule**. Re-add the hook when setting up a new machine.

### The audit

```sql
select * from public.security_posture_audit();
```

Defined in [sql/234_security_posture_audit.sql](sql/234_security_posture_audit.sql),
reworked in [sql/239_security_audit_v2.sql](sql/239_security_audit_v2.sql). Eleven
checks: RLS off, matview reachable by an API role (RLS is impossible on those), definer
view readable by `anon`, definer view with no predicate over a base table, definer
function executable by `anon`, definer function callable by `authenticated` with no
check (reads as well as writes), `EXECUTE` held by `PUBLIC`, public Storage bucket,
`storage.objects` RLS, unsafe realtime publication, and a stale exemption. Run it as
`postgres` (Supabase SQL editor or MCP) or as `service_role`. Then:

```bash
node scripts/security-gate.cjs pass 0
```

The recorded pass is bound to a hash of the exact staged diff. Restage anything and
it is void. `pass` refuses any argument other than `0`.

Record the pass in its own shell call. The hook evaluates the whole command before
any of it runs, so chaining `pass 0` onto the commit still blocks — the pass has not
been written at the moment the gate reads it.

**A finding you have reviewed and accepted goes in `security_audit_exemptions`, with a
reason.** The exemption is bound to a hash of the function definition, so editing an
exempted function re-flags it rather than silently inheriting the old judgement. Do not
loosen the gate regex to make a finding disappear — that is how `raise exception` and a
bare `auth.uid()` came to count as authorisation, which left the audit unable to
re-find its own founding finding.

### The gate is not the only line

The gate guards `git`, but this project changes the database through the MCP and the
SQL editor, which produce no diff to hash. So
[sql/240_security_posture_continuous.sql](sql/240_security_posture_continuous.sql) runs
the same audit every 15 minutes via `pg_cron`, records anything it finds in
`security_posture_findings`, and notifies everyone with `can_manage_portal`. It shows
in `/admin/schedules` as "Security posture audit". Detection you cannot bypass beats
prevention you can — but it is detection, so a finding means prod is already exposed.

### What the audit cannot see

Static checks catch shapes, not semantics. If a diff adds a view or a definer RPC,
verify it by impersonation before recording a pass:

```sql
begin;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"<portal-user-uuid>"}', true);
set local role authenticated;
select count(*) from <new_view>;   -- must be 0
select <new_rpc>();                -- must raise 42501
rollback;
```

Then repeat with an active-staff `sub` and confirm the counts match what staff saw
before the change — a gate that also locks out staff is a different outage, not a fix.

**Querying as `postgres` proves nothing.** `postgres` bypasses RLS, so a definer view
with no gating predicate looks identical to a correctly gated one. This is exactly how
five views went unnoticed while returning 72 clients' bookkeeping data to `anon`.

### Two facts that generate most findings

1. **`authenticated` is not `staff`.** Client-portal users sign in through Supabase
   auth and hold the `authenticated` role alongside staff. A definer function granted
   to `authenticated` with no internal check is callable by a client. Guard with
   `is_staff_or_service()`, which passes staff, `service_role` and no-JWT callers
   (pg_cron, psql) so automation keeps working.

2. **A view is `SECURITY DEFINER` unless it says otherwise**, and a definer view reads
   its base tables as the owner, so RLS never applies. Prefer
   `security_invoker = true` and let the base-table policies do the work. Reserve
   definer views for reading a private schema (the `hmrc` views), and then they must
   carry their own predicate.

**`REVOKE ... FROM anon` is often a no-op.** If the ACL reads `=X/postgres` the grant
belongs to `PUBLIC` and a named-role revoke does nothing. Check
`array_to_string(proacl,' ')`, then `grant to authenticated, service_role` and
`revoke from public`.

**A table-level grant defeats a column-level revoke.** Postgres treats column
privileges as additive, so you cannot withhold one column from a role that holds
SELECT on the table. To hide a secret column: `revoke select on <table> from
authenticated`, then `grant select (every, other, column) ... to authenticated`. This
is why `qbo_connections`, `gdrive_connections`, `reminder_emails` and
`onboarding_chase_config` carry verbose grant lists in
[sql/256](sql/256_hardening_authz_and_secrets.sql). A `select('*')` against such a
table fails, so the frontend must name its columns.

### A secret belongs to `service_role`, not to staff

Tokens, API keys, cron secrets and magic-link tokens are read by edge functions running
as `service_role`, which bypasses RLS. No browser needs them. So the default is that
`authenticated` cannot read the secret column at all — not that a policy limits which
rows it sees. `is_active_staff()` on a table containing a credential is eleven people
holding that credential.

The same applies to data we merely *store*: a Companies House auth code was held for 273
clients and never used, because every consumer only asked whether one existed. Before
adding a column that holds a credential, check whether a boolean does the job. Removing
data beats defending it.

**A one-off `DELETE` is not durable.** The BM importer rewrites what it imports, so
purging a column leaves it repopulated on the next run. Enforce at the table — a
`before insert or update` trigger covers every write path, present and future, and a
CHECK constraint behind it survives the trigger being dropped. See
[sql/257](sql/257_ch_auth_code_becomes_a_flag.sql).

### New mutations go through an edge function

The browser talks straight to PostgREST across ~500 `.from()` call sites and 225
distinct tables and views, so authorisation lives in 402 RLS policies and 163 definer
functions. That is why almost every finding this project has had is an authorisation
finding: the surface is enormous and reviewed by eye.

Migrating to a server-mediated API was costed and declined — see
[docs/SECURITY_FOLLOW_UP_2026-08-24.md](docs/SECURITY_FOLLOW_UP_2026-08-24.md). The
incremental substitute is a rule: **a new mutating path is an edge function, not a
browser table write.** There are already 67 of them. Each one added shrinks the
browser's grants toward read-only, which is most of the benefit of three tiers without
a rewrite. Reads may stay direct where RLS genuinely expresses the rule.
