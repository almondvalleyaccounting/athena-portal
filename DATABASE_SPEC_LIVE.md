# Athena Portal — Live Database Specification (authenticated)

**Source:** live Supabase schema dump (2026-04-19, post-020), project `neksyvneljgxvpchwgch`
**Scope:** `public` schema only — 41 tables, ~20 custom enums, 17 functions, 24 triggers
**Confidence:** Every fact below is taken from `pg_catalog` / `pg_constraint` / `pg_indexes` / `pg_policies` / `pg_enum` / `pg_proc` / `pg_trigger` / `pg_publication_tables` against the live database. Deltas from `CLAUDE.md` and `sql/*.sql` migration files are flagged **[DIVERGENCE]**. Production bugs found in live are flagged **[BUG]**.

**Post-020 note:** migration `sql/020_semantic_fixes.sql` was applied 2026-04-19. Findings §0.3 (orphaned function), §0.4 (quotes.status CHECK/trigger), §0.16 (dead RPC), §4.4 (duplicate updated_at functions) and §5.4 (missing updated_at triggers) are resolved and annotated below.

---

## 0. Critical findings for the architect (read first)

### 0.1 The CLAUDE.md spec is materially out of date
The portal has grown a **client-facing application layer** (`users`, `entity_memberships`, `bookings`, `actions`, `change_requests`, `service_requests`, `fees`, `payments`, `referrals`, `rewards`, `reward_events`, `services`, `service_catalogue`) that is entirely absent from CLAUDE.md, the `sql/` migration files, and the application source under `src/`. These tables were clearly created directly in the Supabase SQL editor. **No migration files exist for them.** Recovering a migration history should be an early task.

### 0.2 Duplicate RLS policies on ~15 tables
Many tables have two policies that do the same thing under different names — one legacy (using the helper `my_entity_ids()`) and one newer (`entity_memberships` direct EXISTS). Examples: `actions`, `bookings`, `change_requests`, `deadlines`, `fees`, `payments`, `referrals`, `rewards`, `services`, `service_requests`, `staff_profiles`, `users`, `entity_memberships`, `audit_log`. No functional harm (Postgres OR-combines policies of the same cmd), but it doubles policy-evaluation cost on every row read. **Deduplicate in one migration.**

### 0.3 `completed_tasks` — delete is audited, update is blocked [RESOLVED vs migration file]
Verified trigger state on live:
- `tg_completed_tasks_no_update` (BEFORE UPDATE) → raises. **Still immutable for updates.**
- `tg_completed_tasks_audit_delete` (BEFORE DELETE) → writes the old row to `audit_log` then returns OLD. **Delete is allowed and audited, not blocked.**
- Function `tg_completed_tasks_no_delete_fn` — **[RESOLVED]** dropped in migration 020.

The original migration's "immutable to delete" design was intentionally replaced with "delete is allowed, audit-logged". RLS permits deletion to `work_planner = true` staff. **The two DELETE policies on `completed_tasks` are still duplicates** (§0.2) and one should be dropped — but the model itself is fine.

### 0.4 `quotes.status` — CHECK / trigger / app alignment [RESOLVED]
Migration 020 (2026-04-19) rewrote the CHECK and state-machine trigger to a single canonical contract. Decisions taken: **D1 = soft delete** (add `deleted` to CHECK, any non-terminal → `deleted`), **D2 = `committed` is a terminal status** (evidence in §0.19 diagnostic — app code in `CommitToLiveModal.jsx`, `QuoteDetailPage.jsx`, `BillingPage.jsx` reads/writes the column and sets `status='committed'`).

**Canonical vocabulary:**
```
draft, pending_approval, approved, sent, accepted, declined, expired, committed, deleted
```

**Transition table (enforced by `tg_quotes_validate_status_fn`):**
```
draft              → pending_approval | deleted
pending_approval   → approved | declined | deleted
approved           → sent | deleted
sent               → accepted | declined | expired | deleted
accepted           → committed | deleted
declined           → draft | deleted
expired            → draft | deleted
committed          → (terminal)
deleted            → (terminal)
```

Self-transitions (`OLD.status = NEW.status`) are allowed. Soft delete is reachable from any non-terminal status. `committed` pairs with `committed_at` / `committed_by` on the row (written by the Commit-to-Live flow); `deleted` is audit-log-backed soft delete.

Q1 diagnostic (2026-04-19) found zero orphaned quotes (`status='accepted' AND committed_at IS NULL` joined to `live_billing`) — no pre-migration backfill was needed, and the Commit-to-Live flow has never completed successfully in production (the pre-020 CHECK rejected `committed`, so the final UPDATE always failed).

### 0.5 Two parallel billing tables with overlapping responsibility
- **`live_billing`** — staff-facing committed billing from quotes, pushed to QBO. Has `services jsonb`, `qbo_recurring_id`, `committed_by`.
- **`billing_items`** — newer table with net/vat/gross, approval workflow (`status` ∈ `draft/pending_approval/approved/pushed/rejected`, `approved_by`).

Unclear whether `billing_items` supersedes `live_billing` or complements it. Architect must decide:
1. Keep both with clear separation (doc which one is authoritative per service), or
2. Migrate `live_billing` into `billing_items` (one row per service line, not one row per entity).

### 0.6 Two parallel QBO OAuth stores
- **`qbo_connections`** — single-tenant billing connection. No unique constraint on `realm_id`.
- **`qbo_report_connections`** — multi-tenant, `realm_id` UNIQUE, per-entity via `entity_id` FK. Used by the Reports module.

These are intentional (billing is one-per-firm, reports are one-per-client) but should be documented as such. Consider renaming `qbo_connections` → `qbo_billing_connection` (singular) for clarity.

### 0.7 Staff/user identity split
Two separate identity tables both backed by `auth.users`:
- **`staff_profiles`** — AVA staff. FK `id → auth.users(id) ON DELETE CASCADE`.
- **`users`** — external client portal users. Same FK pattern. Has `tier` (loyalty), `points`, `referral_code`, `phone`, `address`.

They coexist — `auth.users.id` is unique, so a user is either staff OR client, not both. Client-side RLS uses the helper `my_entity_ids()` plus/instead of `entity_memberships.user_id = auth.uid()`.

### 0.8 `staff_profiles` column-name drift [DIVERGENCE]
CLAUDE.md says `full_name` and `role`. Live has `name` (not `full_name`) and **no `role` column at all**. Everywhere CLAUDE.md references `role = 'manager'` is vestigial. Manager-tier gating is done via the individual permission booleans. Update the spec or add the column.

### 0.9 Permission-flag naming is inconsistent [DIVERGENCE]
All permissions use `can_*` prefix **except** `work_planner`. CLAUDE.md spec calls it `can_view_work_planner`. Live RLS policies reference `work_planner`. Recommend:
```sql
ALTER TABLE staff_profiles RENAME COLUMN work_planner TO can_view_work_planner;
```
Followed by updating every RLS `USING` clause that references it (13 policies across `completed_tasks`, `instance_overrides`, `quick_tasks`, `scheduled_tasks`, `task_progress_notes`).

### 0.10 QBO token plaintext storage
`qbo_connections.access_token` and `refresh_token` are `TEXT NOT NULL`, unencrypted at rest. Recommend Supabase Vault (`vault.secrets`) or pgsodium column encryption. Same applies to `qbo_report_connections` if/when it starts storing tokens (currently it only stores realm/metadata — actual tokens live elsewhere, architect to confirm).

### 0.11 `entities.name` is UNIQUE
Will block creation of two clients with the same legal name (e.g. two "Smith Ltd" in different groups). Drop this or scope it by `billing_group`/`company_number`.

### 0.12 `billing_group_members.pkey` is on `entity_id` alone
An entity can belong to **only one** billing group. Intentional? If not, change to composite `(entity_id, group_id)`.

### 0.13 FK-target inconsistency on `created_by` / `updated_by`
Some tables FK to `auth.users(id)`, others FK to `staff_profiles(id)`:
- **→ `auth.users`**: `audit_log.user_id`, `quotes.created_by`, `quotes.approved_by`, `quote_defaults.created_by`, `staff_profiles.updated_by`
- **→ `staff_profiles`**: everything else (`quick_tasks.created_by`, `scheduled_tasks.created_by`, `billing_groups.created_by`, `live_billing.committed_by`, `report_runs.triggered_by`, etc.)

Pick one convention. `staff_profiles(id)` is the stronger choice because it guarantees the creator had a staff profile at write time.

### 0.14 Missing foreign keys
- `task_progress_notes.task_id` is polymorphic (keyed by `task_type`) — **no FK possible**. Acceptable, but note it.
- `live_billing` has no FK on `qbo_customer_id` / `qbo_recurring_id` (they're external IDs, acceptable).
- `quotes.committed_by` has no FK declared. Should reference `staff_profiles(id)`.

### 0.15 `schema_migrations` RLS is DISABLED
Only table in `public` with RLS off. Intentional for migration tooling. Flag for security review — should be read-only for `authenticated`.

### 0.16 `insert_progress_note()` RPC — dead code [RESOLVED]
Function dropped in migration 020. Diagnostic confirmed the UI was bypassing the RPC via direct INSERT to `task_progress_notes` (6 rows with `created_by_name` populated, 2026-04-15 → 2026-04-16), so no replacement needed.

### 0.17 Duplicate RLS policies are *literal* duplicates, not semantic variants [confirmed]
Now that `my_entity_ids()` body is visible:
```sql
select entity_id from public.entity_memberships where user_id = auth.uid();
```
…the "legacy" policies that use `my_entity_ids()` and the "newer" policies that inline `entity_memberships` direct EXISTS are querying the same data. Postgres evaluates both on every row read. Dropping half of the policies gives a free ~2× speedup on client-portal reads (§0.2 is worse than "just cosmetic").

### 0.19 `live_billing` shape — one row per entity, not per service line
Discovered while drafting the Q2 diagnostic for migration 020. `live_billing` stores services as a `services jsonb` column; there is no `service_id` column and no one-row-per-line model. Relevant context for the open §0.5 decision (consolidation with `billing_items`, which *is* one row per line). No action required now — flagging so a future consolidation design does not assume schema parity.

### 0.18 Client-portal tables are NOT in realtime publication [gap]
Live `supabase_realtime` publication contains only the five Work Planner tables:
```
completed_tasks, instance_overrides, quick_tasks, scheduled_tasks, task_progress_notes
```
If the client portal is expected to show live state (new `actions` appearing, `fees.status` changing, `bookings` updating) without polling, these tables need adding:
```sql
ALTER PUBLICATION supabase_realtime
  ADD TABLE actions, fees, payments, bookings, change_requests, service_requests, services;
```
Optional for staff side: add `quotes`, `quote_events` for Home-screen live counts.

---

## 1. Inventory (41 tables)

| # | Table | Cols | RLS | FKs | Purpose |
|---|---|---|---|---|---|
| 1 | `actions` | 15 | ✓ | 2 | Client-facing action CTAs (upload, form, approval, link) |
| 2 | `audit_log` | 7 | ✓ | 1 | Staff action trail (append-only) |
| 3 | `billing_group_members` | 3 | ✓ | 2 | Entity ↔ billing_group join (one-group-per-entity) |
| 4 | `billing_groups` | 5 | ✓ | 1 | Relationship group |
| 5 | `billing_items` | 12 | ✓ | 3 | Approval-workflow billing lines (see §0.5) |
| 6 | `bookings` | 12 | ✓ | 2 | Client meetings with calendar integration |
| 7 | `bug_reports` | 6 | ✓ | 1 | Staff bug submission inbox |
| 8 | `change_requests` | 7 | ✓ | 1 | Client change-of-details requests |
| 9 | `completed_tasks` | 12 | ✓ | 3 | Work-planner completion log (see §0.3) |
| 10 | `deadlines` | 9 | ✓ | 1 | Statutory/filing deadlines |
| 11 | `entities` | 22 | ✓ | 0 | Core client record (UTR, VAT, PAYE, CH, HMRC refs) |
| 12 | `entity_fees` | 12 | ✓ | 1 | Committed per-service fee, unique per `(entity_id, service_id)` |
| 13 | `entity_memberships` | 4 | ✓ | 2 | `users` ↔ `entities` join with `membership_role` |
| 14 | `fees` | 11 | ✓ | 1 | Client-facing fee/invoice records (distinct from `live_billing`) |
| 15 | `ideas` | 6 | ✓ | 1 | Staff idea submissions |
| 16 | `instance_overrides` | 12 | ✓ | 2 | Per-occurrence override of recurring `scheduled_tasks` |
| 17 | `issues_log` | 14 | ✓ | 3 | Staff-managed issue tracker |
| 18 | `live_billing` | 20 | ✓ | 3 | Staff-facing committed billing, QBO-linked (see §0.5) |
| 19 | `payments` | 12 | ✓ | 1 | HMRC/tax payments due (`tax_type` enum) |
| 20 | `qbo_connections` | 15 | ✓ | 1 | QBO OAuth for billing (single realm) |
| 21 | `qbo_report_connections` | 7 | ✓ | 2 | QBO OAuth for Reports (multi-realm, per-entity) |
| 22 | `qbo_sync_log` | 11 | ✓ | 2 | QBO push/pull audit |
| 23 | `quick_tasks` | 13 | ✓ | 3 | Work-planner ad-hoc tasks |
| 24 | `quote_defaults` | 7 | ✓ | 1 | Pricing rulebook (partial-unique `is_current`) |
| 25 | `quote_entities` | 9 | ✓ | 2 | Multi-entity quote rows with per-entity discount |
| 26 | `quote_events` | 9 | ✓ | 1 | Client-side quote telemetry (service-role writes only) |
| 27 | `quote_line_items` | 10 | ✓ | 2 | Priced quote lines (cascade delete from `quote_entities` and `quotes`) |
| 28 | `quotes` | 41 | ✓ | 5 | Fee Engine quote record |
| 29 | `referrals` | 9 | ✓ | 1 | Client referral tracking |
| 30 | `report_runs` | 15 | ✓ | 1 | QBO report extraction dispatch log |
| 31 | `reward_events` | 6 | ✓ | 1 | Loyalty event log (12 event types) |
| 32 | `rewards` | 6 | ✓ | 1 | Client user points/tier state |
| 33 | `scheduled_tasks` | 18 | ✓ | 4 | Work-planner recurring/scheduled master |
| 34 | `schema_migrations` | 3 | ✗ | 0 | Migration tracking (RLS disabled — see §0.15) |
| 35 | `service_catalogue` | 8 | ✓ | 0 | Available services menu |
| 36 | `service_requests` | 9 | ✓ | 2 | Clients requesting new services |
| 37 | `services` | 9 | ✓ | 1 | Active services per entity |
| 38 | `staff_profiles` | 24 | ✓ | 2 | Staff identity + permission flags |
| 39 | `task_progress_notes` | 9 | ✓ | 1 | Append-only notes on tasks (polymorphic) |
| 40 | `timesheet_entries` | 11 | ✓ | 2 | Staff timesheets (minutes per day per entity) |
| 41 | `users` | 12 | ✓ | 1 | Client portal users (loyalty, referrals) |

---

## 2. Custom enums

### 2.1 Business enums

| Enum | Values | Used by |
|---|---|---|
| `action_cta_type` | `upload, form, approval, link` | `actions.cta_type` |
| `action_status` | `pending, in_progress, completed, dismissed` | `actions.status` |
| `auth_provider` | `google, email` | `users.auth_provider` |
| `booking_payment` | `included, paid, pending` | `bookings.payment_status` |
| `booking_status` | `booked, completed, cancelled` | `bookings.status` |
| `change_req_status` | `submitted, in_progress, completed` | `change_requests.status` |
| `deadline_status` | `action, payment, filing, complete, pending, overdue` | `deadlines.status` (default `filing`) |
| `deadline_tag` | 15 values — `VAT, Tax, Payroll, Accounts, Co House, CH Accounts, CT600, SA Return, Confirmation Statement, Charity Commission, MTD Final Declaration, MTD Quarterly Filing, Management Accounts, P11D, Auto-Enrolment` | `deadlines.tag` |
| `entity_type` | `limited_company, sole_trader, partnership, personal` | `entities.type` |
| `fee_status` | `overdue, current, paid` | `fees.status` (default `current`) |
| `membership_role` | `owner, director, authorised, partner, secondary_contact` | `entity_memberships.role` (default `authorised`) |
| `package_tier` | `essentials, standard, premium, advisory` | `services.package_tier` |
| `payment_status` | `overdue, due_soon, upcoming, paid` | `payments.status` (default `upcoming`) |
| `referral_status` | `pending, onboarding, active, credited` | `referrals.status` |
| `reward_status` | `pending, applied` | `referrals.reward_status` |
| `service_req_status` | `requested, quoted, accepted, declined` | `service_requests.status` |
| `service_status` | `active, pending, cancelled` | `services.status` |
| `source_skill_type` | `vat-review, year-end-review, payroll-qc, team` | `actions.source_skill` (default `team`) |
| `tax_type` | `corporation_tax, vat, self_assessment, paye` | `payments.tax_type` |
| `tier_level` | `bronze, silver, gold, platinum` | `users.tier`, `rewards.tier` (default `bronze`) |
| `urgency_level` | `overdue, urgent, normal` | `actions.urgency` (default `normal`) |

### 2.2 Inherited / system enums (do not touch)
`aal_level`, `action` (Supabase realtime), `buckettype`, `code_challenge_method`, `equality_op`, `factor_status`, `factor_type`, `oauth_authorization_status`, `oauth_client_type`, `oauth_registration_type`, `oauth_response_type`, `one_time_token_type` — all owned by Supabase `auth`/`storage`/`realtime` schemas.

---

## 3. Table-by-table detail

> Columns are shown in DDL order. `?` = nullable. `PK` = primary key. `U` = part of UNIQUE constraint. `FK→table.col` = foreign key with target. `[CHECK]` = check constraint applies (listed separately).

### 3.1 `staff_profiles`
```
id                     uuid      PK, FK→auth.users.id ON DELETE CASCADE
name                   text
email                  text      U
is_active              bool      = true
can_view_quotes        bool      = false
can_edit_quotes        bool      = false
can_approve_quotes     bool      = false
can_edit_fee_schedule  bool      = false
can_view_client_fees   bool      = false
can_manage_portal      bool      = false
created_at             timestamptz = now()
updated_at             timestamptz = now()
updated_by             uuid?     FK→auth.users.id
can_view_reports       bool?     = false
can_view_pd_tracker    bool?     = false
must_change_password   bool      = true
work_planner           bool?     = false        -- see §0.9
can_view_timesheets    bool?     = false
colour                 text?                     -- British spelling
can_view_billing       bool?     = false
can_approve_billing    bool?     = false
working_days           text?     = 'mon,tue,wed,thu,fri'  -- CSV not array
is_portal_admin        bool?     = false
```
**Missing (vs CLAUDE.md):** `full_name` (it's `name`), `role` (does not exist).
**RLS:** seven policies — admins manage all via `is_portal_admin()`, users read own via `id = auth.uid()`, `authenticated` role can read all. **Four of seven are duplicates** (see §0.2).

### 3.2 `entities` (22 cols)
```
id                  uuid        PK
name                text        U        -- see §0.11
type                entity_type
company_number      text?                 -- unique when not null (partial idx)
utr                 text?
vat_number          text?
paye_ref            text?
accounts_office_ref text?
hmrc_gateway_id     text?
ni_number           text?
color               text?                 -- note US spelling (staff uses 'colour')
bm_client_id        text?                 -- BrightManager import key
created_at          timestamptz
updated_at          timestamptz
manager             text?                 -- free-text, no FK
grade               text?                 -- tier?
ch_auth_code        text?                 -- Companies House auth code
status              text?       = 'active'
qbo_customer_id     text?
qbo_customer_name   text?
source              text?       = 'brightmanager'
prospect_email      text?
```
**Indexes:** `(name) UNIQUE`, `(company_number) UNIQUE WHERE NOT NULL`, `(bm_client_id) WHERE NOT NULL`.
**No FK targets on `manager`** — should probably reference `staff_profiles(id)`.

### 3.3 `users` (client-portal)
```
id             uuid       PK, FK→auth.users.id ON DELETE CASCADE
email          text       U
name           text
phone          text?
address        text?
auth_provider  auth_provider = 'google'
tier           tier_level    = 'bronze'
points         int        = 0
streak_days    int        = 0
referral_code  text?      U
created_at     timestamptz
updated_at     timestamptz
```
**Loyalty state (`tier`, `points`, `streak_days`) is duplicated on `rewards`** — source-of-truth decision needed.

### 3.4 `entity_memberships`
```
user_id    uuid  FK→users.id ON DELETE CASCADE    -- PK part
entity_id  uuid  FK→entities.id ON DELETE CASCADE -- PK part
role       membership_role = 'authorised'
created_at timestamptz
```
Composite PK `(user_id, entity_id)`. Indexes on both sides.

### 3.5 `quotes` (41 cols)
Key columns and deltas from CLAUDE.md:
```
id, quote_ref U, entity_id FK→entities, group_id FK→billing_groups,
status text [CHECK in draft/pending_approval/approved/sent/accepted/declined/expired/committed/deleted],  -- post-020, see §0.4
relationship_group text?, valid_until date?,

-- Money (all NUMERIC, no precision cap)
estimated_turnover, annual_services, annual_software, annual_total,
monthly_net, monthly_vat, monthly_gross, one_off_total,

defaults_version text?,             -- TEXT, not integer  [DIVERGENCE]

-- JSONB snapshots
directors, setup_fees, payroll_detail, bookkeeping_detail, software_detail,
budgeting_lines, accounts_detail, modulr_detail, management_accounts_detail,
review_meetings_detail, budgeting_detail, cfo_detail,

notes text?,

-- Ownership
created_by   FK→auth.users,        -- [DIVERGENCE: should be staff_profiles]
approved_by  FK→auth.users,
committed_by uuid?,                 -- no FK declared (§0.14)

-- Timestamps
created_at, updated_at, approved_at, sent_at, accepted_at, committed_at,

-- Client acceptance audit
accepted_client_email, accepted_ip, accepted_user_agent
```
**No `accepted_by`** (CLAUDE.md said it exists — it doesn't).
**CHECK aligned with app post-020.** See §0.4 for the canonical vocabulary and transition table.
**Indexes:** PK, `quote_ref UNIQUE`. No index on `entity_id`, `status`, `group_id`, `valid_until` — add if Home screen "awaiting approval" / "expiring" queries become hot.

### 3.6 `quote_line_items`
```
id, quote_id FK→quotes CASCADE, service_id text, description text,
annual_amount, monthly_amount?, detail text?, is_recurring bool = true,
sort_order int = 0,
quote_entity_id uuid? FK→quote_entities CASCADE    -- multi-entity quote support
```
**No index on `(quote_id, sort_order)`** — add for list queries.

### 3.7 `quote_entities`
```
id, quote_id FK→quotes CASCADE, entity_id FK→entities,
discount_pct numeric = 0, annual_before_discount, annual_after_discount,
monthly_gross, sort_order int?, details jsonb = '{}'
```
**No unique constraint on `(quote_id, entity_id)`** — same entity could appear twice. Add.

### 3.8 `quote_defaults`
```
id, version text U, is_current bool = false [UNIQUE WHERE is_current=true],
rates jsonb, notes text?, created_by FK→auth.users, created_at
```
Partial unique index `quote_defaults_one_current` enforces singleton "current" version. Good pattern. [DIVERGENCE: my earlier inference said blob of service-keyed JSONB columns — actually it's one `rates` jsonb column.]

### 3.9 `quote_events`
Matches the migration file exactly. 6-value `event_type` CHECK (`delivered, opened, clicked_review, accepted, bounced, complained`). Only SELECT policy — writes are service-role only. ✓

### 3.10 `live_billing`
20 columns. Matches the migration file. **Missing indexes** on `entity_id`, `committed_at`, `qbo_sync_status` — Home screen sums on `committed_at >= week_start` would benefit from a partial index.

### 3.11 `billing_items` (NEW vs CLAUDE.md)
```
id, entity_id FK→entities, service text?, description text?,
net_amount numeric(10,2) = 0, vat_amount numeric(10,2) = 0, gross_amount numeric(10,2) = 0,
status text [CHECK in draft/pending_approval/approved/pushed/rejected],
created_by FK→staff_profiles, approved_by FK→staff_profiles, approved_at, created_at
```
Parallel to `live_billing` with explicit approval workflow. **Unclear which is authoritative** (§0.5).

### 3.12 `fees` (NEW — client-facing)
```
id, entity_id FK→entities CASCADE, invoice_number text, description text,
amount numeric(12,2), due_date date,
status fee_status = 'current',
payment_url text?, qbo_invoice_id text?, created_at, updated_at
UNIQUE (entity_id, invoice_number)
```
Read-only to clients via `my_entity_ids()` / `entity_memberships`.

### 3.13 `payments` (NEW — HMRC dues)
```
id, entity_id FK→entities CASCADE, tax_type tax_type, description text,
amount numeric(12,2), due_date date,
hmrc_ref text?, hmrc_pay_url text?,
status payment_status = 'upcoming', live_status text?, created_at, updated_at
UNIQUE (entity_id, tax_type, due_date)
```

### 3.14 `actions` (NEW — client CTAs)
```
id, entity_id FK→entities CASCADE,
source_skill source_skill_type = 'team', source_reference text?,
urgency urgency_level = 'normal',
title text, description text?, deadline date,
cta_type action_cta_type = 'upload', cta_label text = 'Upload', cta_target text?,
status action_status = 'pending',
created_at, completed_at, created_by FK→staff_profiles
UNIQUE (entity_id, title, deadline)
```
Generated by AI skills (`source_skill`) or staff (`team`). Clients see/update via `my_entity_ids()`.

### 3.15 `bookings` (NEW — client meetings)
```
id, user_id FK→users CASCADE, entity_id FK→entities ON DELETE SET NULL,
duration_minutes int [CHECK ∈ 30/60/90],
scheduled_at, is_included bool = false, amount numeric(12,2) = 0,
payment_status booking_payment = 'pending', calendar_event_id text?,
status booking_status = 'booked', created_at, updated_at
```

### 3.16 `services` / `service_catalogue` / `service_requests` (NEW trio)
- **`service_catalogue`** — menu of available services (`service_name`, `description`, `price_label`, `sort_order`, `is_active`, `canonical_service_id`). Public read (RLS `true`).
- **`services`** — active services per entity (`service_name`, `fee text`, `status service_status`, `package_tier`, `canonical_service_id`). **Note `fee` is TEXT not numeric** — probably a display label.
- **`service_requests`** — client-initiated ("I'd like management accounts"). Status flows through `service_req_status` enum (requested → quoted → accepted/declined).

### 3.17 `rewards` / `reward_events` / `referrals` (loyalty)
- **`rewards`** — one row per user, PK = `user_id`. Current `points`, `tier`, `streak_days`.
- **`reward_events`** — append-only event log, 12 `event_type` values including `action_completed`, `invoice_paid_on_time`, `streak_milestone`, `referral_converted`, `tier_upgrade`, `points_redeemed`.
- **`referrals`** — referrer + referred contact, `status referral_status`, `reward_amount` (default 50.00), `reward_status`.

### 3.18 `change_requests` (NEW)
```
id, user_id FK→users CASCADE, change_types text[], notes text?,
status change_req_status = 'submitted', submitted_at, updated_at
```
Note: **no `entity_id`** — change requests are per-user, not per-entity. May need an entity FK if scope is per-business.

### 3.19 `issues_log` (NEW — staff issue tracker)
```
id, title, description?,
priority text [CHECK in critical/high/medium/low] = 'medium',
category text = 'Other',
status text [CHECK in open/investigating/in_progress/awaiting_response/resolved/closed] = 'open',
reported_by FK→staff_profiles, reported_by_name text?, assignee_id FK→staff_profiles,
entity_id FK→entities, resolution_notes?, resolved_at?, closed_at?, created_at
```
No indexes beyond PK — will slow as the log grows.

### 3.20 `bug_reports` (NEW)
Minimal: `id, description, status [CHECK in open/in_progress/closed], submitted_by FK→staff_profiles, submitted_by_name, created_at`. Distinct from `issues_log` — probably user-submitted feedback vs. tracked issues.

### 3.21 `timesheet_entries` (NEW)
```
id, staff_id FK→staff_profiles, entity_id FK→entities?, service text?,
work_date date, minutes int = 0, notes text?,
source text [CHECK in completed/manual] = 'manual',
source_task_id uuid?, created_at, updated_at
```
Index: `(staff_id, work_date)`. Ties back to `completed_tasks` via `source_task_id`.

### 3.22 `qbo_report_connections` (NEW — separate from qbo_connections)
```
id, realm_id text U, company_name text,
connected_by FK→staff_profiles, connected_at,
status text [CHECK in active/disconnected] = 'active',
entity_id FK→entities
```
No tokens stored here — OAuth tokens live on the edge-function side or in `qbo_connections`. Architect to confirm.

### 3.23 `deadlines` — now with FK enforced
Live has `FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE`. My earlier spec said "FK unenforced" — **that was wrong**. It is enforced.

### 3.24 Full enum values now confirmed (`deadline_tag`, `deadline_status`)
Previously "TBC" in my draft. Now authoritative — see §2.1.

### 3.25 Work Planner tables — match migration file
`quick_tasks`, `scheduled_tasks`, `instance_overrides`, `completed_tasks`, `task_progress_notes` all match `sql/work_planner_migration.sql` except:
- `completed_tasks` has active DELETE policies (see §0.3).
- `task_progress_notes` now has an `occurrence_date date?` column added after the initial migration. Index updated to `(task_type, task_id, occurrence_date)`.

### 3.26 `audit_log`
`user_id` FK → **`auth.users`** (not `staff_profiles`). [DIVERGENCE from my earlier inference.] No indexes beyond PK. For fast "recent actions for user X" queries, add `(user_id, created_at DESC)` and `(entity_type, entity_id)`.

---

## 4. Functions (17 in `public`)

### 4.1 RLS helpers
| Function | Security | Body |
|---|---|---|
| `is_active_staff() → bool` | DEFINER | `SELECT EXISTS(SELECT 1 FROM staff_profiles WHERE id = auth.uid() AND is_active = true)` |
| `is_portal_admin() → bool` | DEFINER | `SELECT COALESCE((SELECT is_portal_admin FROM staff_profiles WHERE id = auth.uid()), false)` |
| `my_entity_ids() → SETOF uuid` | DEFINER | `SELECT entity_id FROM entity_memberships WHERE user_id = auth.uid()` |

All three are `SECURITY DEFINER` because they read `staff_profiles` / `entity_memberships`, both RLS-guarded. Cache-safe — pure reads. Used across ~40 policies.

### 4.2 Admin helpers (SECURITY DEFINER, portal-admin-gated)
| Function | Purpose |
|---|---|
| `list_auth_users() → TABLE(id, email, created_at, last_sign_in_at)` | Admin-only `auth.users` enumeration. Raises if caller not `is_portal_admin()`. |
| `admin_update_user_email(p_user_id uuid, p_new_email text) → void` | Atomic update of `auth.users.email` + `staff_profiles.email`. Admin-gated. |

### 4.3 Trigger functions — immutability guards
| Function | Behaviour |
|---|---|
| `fn_audit_log_immutable()` | Raises on UPDATE/DELETE of `audit_log`. Wired to `tg_audit_log_no_update`, `tg_audit_log_no_delete`. |
| `prevent_qbo_sync_log_modification()` | Raises on UPDATE/DELETE. Wired on `qbo_sync_log`. |
| `prevent_report_runs_modification()` | Raises on UPDATE/DELETE. Wired on `report_runs`. |
| `prevent_reward_events_modification()` | Raises on UPDATE/DELETE. Wired on `reward_events`. |
| `tg_completed_tasks_no_update_fn()` | Raises on UPDATE. Wired on `completed_tasks`. |
| `tg_completed_tasks_no_delete_fn()` | **[RESOLVED]** dropped in migration 020. |
| `tg_completed_tasks_audit_delete_fn()` | Inserts OLD row into `audit_log` on DELETE, returns OLD. Wired as `tg_completed_tasks_audit_delete`. |
| `tg_quotes_validate_status_fn()` | State-machine guard on `quotes.status`. See §0.4 for the bug. |

### 4.4 Trigger functions — `updated_at` maintenance [RESOLVED]
`set_updated_at()` is the generic `NEW.updated_at = now(); RETURN NEW;` function. Migration 020 dropped the two table-specific copies (`update_quotes_updated_at()`, `update_staff_profiles_updated_at()`) and repointed their triggers at `set_updated_at()`. All 19 `trg_*_updated_at` triggers now route through the single canonical function.

### 4.5 Business helpers
| Function | Purpose |
|---|---|
| `generate_referral_code() → text` | Generates `'AV-' + 4 chars from ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Ambiguous chars (`0/O, 1/I`) excluded. Used to populate `users.referral_code`. No uniqueness check in the function — relies on `users.referral_code` UNIQUE constraint to retry at the call site. |
| `insert_progress_note(...)` | **[RESOLVED §0.16]** dropped in migration 020. |

### 4.6 State-machine trigger — actual transitions (from `tg_quotes_validate_status_fn`, post-020)
See §0.4 for the full transition table. Summary: vocabulary is `draft, pending_approval, approved, sent, accepted, declined, expired, committed, deleted`; `committed` and `deleted` are terminal; soft delete is reachable from any non-terminal status; self-transitions are allowed.

---

## 5. Triggers (24 triggers on 17 tables)

### 5.1 Immutability / audit
| Table | Trigger | When | Effect |
|---|---|---|---|
| `audit_log` | `tg_audit_log_no_update` | BEFORE UPDATE | raises |
| `audit_log` | `tg_audit_log_no_delete` | BEFORE DELETE | raises |
| `qbo_sync_log` | `tg_qbo_sync_log_no_update` | BEFORE UPDATE | raises |
| `qbo_sync_log` | `tg_qbo_sync_log_no_delete` | BEFORE DELETE | raises |
| `report_runs` | `tg_report_runs_no_update` | BEFORE UPDATE | raises |
| `report_runs` | `tg_report_runs_no_delete` | BEFORE DELETE | raises |
| `reward_events` | `tg_reward_events_no_update` | BEFORE UPDATE | raises |
| `reward_events` | `tg_reward_events_no_delete` | BEFORE DELETE | raises |
| `completed_tasks` | `tg_completed_tasks_no_update` | BEFORE UPDATE | raises |
| `completed_tasks` | `tg_completed_tasks_audit_delete` | BEFORE DELETE | writes to `audit_log`, allows |

### 5.2 Domain logic
| Table | Trigger | When | Effect |
|---|---|---|---|
| `quotes` | `tg_quotes_validate_status` | BEFORE UPDATE | state-machine guard (§4.6, §0.4) |

### 5.3 `updated_at` maintenance (generic)
Applied to: `bookings`, `change_requests`, `deadlines`, `entities`, `fees`, `payments`, `quotes` (via its own copy), `referrals`, `rewards`, `service_requests`, `services`, `staff_profiles` (via its own copy), `users`.

### 5.4 Missing `updated_at` triggers [RESOLVED]
Migration 020 added `set_updated_at()` triggers on the six tables that had an `updated_at` column but no trigger: `live_billing`, `scheduled_tasks`, `quick_tasks`, `instance_overrides`, `entity_fees`, `qbo_connections`. `billing_groups` has no `updated_at` column so no trigger needed.

---

## 6. Realtime publication

Live `supabase_realtime` publication contains only:
```
public.completed_tasks
public.instance_overrides
public.quick_tasks
public.scheduled_tasks
public.task_progress_notes
```
Matches the Work Planner migration exactly. See §0.18 for tables that should likely be added.

---

## 7. Migration plan (architect-approved 2026-04-19)

### 7.1 Migration order

**Migration 020 — semantic fixes [APPLIED 2026-04-19]**
File: `sql/020_semantic_fixes.sql` (numbered 020 because 010 was already taken by the admin module). Decisions D1 (soft delete) and D2 (`committed` as terminal status) resolved per §0.4. All six sub-tasks completed — see §0.3, §0.4, §0.16, §4.4, §5.4.

**Migration 021 — RLS policy deduplication**
Separate migration because it's mechanical, high blast radius, and benefits from independent reversibility. Drop the `_member` / legacy duplicate policies across the 15 affected tables (§0.2, §0.17). Keep the `my_entity_ids()` variants as the canonical form.

**Migration 022 — client-portal table backfill**
Generate `CREATE TABLE` (+ CHECK + FK + index + RLS) statements for the 19 tables built in the Supabase UI and never migrated (§0.1). Reconcile with `schema_migrations`. This is the biggest long-term risk — no migration history means no rollback, no environment parity, no second dev can rebuild from scratch.

**Backlog (not scheduled yet)**

- **Reconcile `billing_items` vs `live_billing`** (§0.5). Likely wants a migration to consolidate.
- **Extend realtime publication** to client-portal tables if they're meant to be live (§0.18).
- **Encrypt QBO tokens** (§0.10) via Supabase Vault or pgsodium.
- **Rename `work_planner` → `can_view_work_planner`** (§0.9) with cascade into all policies.
- **Normalise FK targets** — pick `staff_profiles(id)` over `auth.users(id)` for ownership columns (§0.13).
- **Add missing FK** on `quotes.committed_by` and composite unique on `quote_entities(quote_id, entity_id)`.
- **Review `entities.name UNIQUE`** (§0.11) and `billing_group_members.pkey = entity_id` (§0.12) — both restrict real-world data scenarios.

### 7.2 Authority note
Architect (2026-04-19): stand `DATABASE_SPEC_LIVE.md` up as the authoritative reference. `CLAUDE.md` is frozen pending Migration 022 — once the client-portal tables have `CREATE TABLE` statements on disk, CLAUDE.md can be rewritten against reality.

---

## 8. Appendix — raw dumps

The following CSVs are the primary sources for this document. Keep them with the spec for the architect's reference:

- `Supabase Snippet RLS Status per Public Table.csv` — 41 tables, all RLS state
- `Supabase Snippet Public Table Column Metadata as JSON.csv` — every column with type/default/nullability
- `Supabase Snippet Public Table Constraints Export.csv` — PKs, FKs, UNIQUE, CHECK
- `Supabase Snippet List Public Table Index Definitions.csv` — every index's DDL
- `Supabase Snippet RLS Policy Export by Table.csv` — every policy's USING/WITH CHECK
- `Supabase Snippet List Public Schema Functions.csv` — all 17 `public` function bodies
- `Supabase Snippet Public Trigger Inventory.csv` — all 23 triggers with definitions
- `Supabase Snippet Realtime Publication Tables.csv` — `supabase_realtime` membership
- Enums dump — see §2.1

Fetched 2026-04-19 against project `neksyvneljgxvpchwgch`. Regenerate periodically — suggest a recurring monthly pull so the spec stays authoritative as the client-portal tables evolve.
