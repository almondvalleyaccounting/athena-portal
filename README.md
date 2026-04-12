# AthenaPortalShell_Spec_v1.0

> Read this file in full before doing anything. It is the single source of truth for this codebase.

---

## What this repo is

`almondvalleyaccounting/athena-portal` is the Athena practice operating system for Almond Valley Accounting. It is a staff-facing portal (not client-facing) running at `portal.almondvalleyaccounting.co.uk`.

The repo currently contains the **Fee Engine v2.0** — a live, production application handling quotes, billing, client management, and QuickBooks Online integration. It is in active use.

**This build adds a shell layer around the Fee Engine** and prepares the codebase for multiple modules. The Fee Engine itself is not being rewritten — it is being wrapped.

---

## Stack

- **React 18** + **Vite**
- **Tailwind CSS**
- **React Router v6** (layout routes / `<Outlet />`)
- **Supabase** — project ref `neksyvneljgxvpchwgch`
  - Auth: Supabase Auth (email/password)
  - Database: PostgreSQL with RLS
  - Edge Functions: Supabase Edge Functions (Deno)
- **Vercel** — auto-deploys from `main` branch
- **Lucide React** — icon library

---

## What already exists (DO NOT touch unless instructed)

All existing code under `src/` is live production code. The Fee Engine routes live under `/manage/*`. Do not refactor, rename, or restructure any existing files unless a task explicitly requires it.

Specifically, never touch:
- Any existing component in `src/components/`
- Any existing page in `src/pages/`
- Any existing Supabase client config in `src/lib/`
- The Supabase Edge Functions (`qbo-auth`, `qbo-status`, `qbo-push`, `qbo-pull`)
- The `qbo_connections`, `qbo_sync_log`, `live_billing`, `quotes`, `quote_line_items`, `quote_defaults`, `quote_entities`, `entities`, `entity_fees`, `billing_groups`, `billing_group_members`, `staff_profiles`, `audit_log` tables

---

## Pre-completed infrastructure — do not redo these

The following has already been done in Supabase before this Code session started.
Do not run these again — they will error on duplicates.

**`report_runs` table** — created and RLS policies applied. ✓

**`staff_profiles` new columns** — `can_view_reports`, `can_view_work_planner`,
`can_view_pd_tracker`, and `can_manage_portal` added. `can_view_reports = true`
and `can_manage_portal = true` set for the portal owner. ✓

**Supabase Edge Function secret** — `MAKE_REPORT_WEBHOOK_URL` is set in project
secrets. Available to all Edge Functions without any additional config. ✓

**RLS policies on `staff_profiles`** — existing policies already use
`is_portal_admin()` which checks `can_manage_portal = true`. No new policies
needed. Do not create any additional RLS policies on `staff_profiles`. ✓

---

## Build sequence — do tasks in this order

**Step 1 — Auth shell (start here)**
Create `src/shell/LoginPage.jsx` and `src/shell/AppShell.jsx`. Wire Supabase session check. Redirect to `/home` on successful login. Redirect unauthenticated users to `/login` from all protected routes. Do not build anything else until this works end-to-end.

**Step 2 — Sidebar and routing**
Create `src/modules.config.js` (spec below). Create `src/shell/Sidebar.jsx` reading from that config. Wire Fee Engine routes under `/manage/*` via `<Outlet />` inside `AppShell`. A logged-in user should be able to reach the Fee Engine through the new shell with no behaviour change.

**Step 3 — Top bar**
Create `src/shell/TopBar.jsx`. Module-aware breadcrumb. User avatar with initials (from `staff_profiles`). Notifications bell (decorative — no functionality yet). AVA logo right-aligned.

**Step 4 — Home screen structure**
Create `src/shell/HomeScreen.jsx`. Build the full layout with hardcoded/placeholder data. No live data queries yet. The structure must match the spec exactly — do not simplify it.

**Step 5 — Home screen data**
Wire the "Needs attention" section to real Supabase data: quotes with status `awaiting_approval` where the user has `can_approve_quotes`. Wire the "This week" stats from `quotes` and `live_billing` tables.

**Step 6 — Ideas module**
Create `src/modules/ideas/IdeasPage.jsx`. New Supabase table required: `ideas` (schema below). Move the ideas concept from the old portal draft into this module. Wire to Supabase.

**Step 7 — Reports stub**
Create `src/modules/reports/ReportsPage.jsx` as a placeholder page. Route `/reports` to it. Nav item becomes live (hidden if user lacks `can_view_reports`).

**Step 8 — Staff Management**
Create `src/admin/StaffManagement.jsx`. Wire to `/admin/staff`. Visible in sidebar only when `can_manage_portal = true`. Full spec in the Permission model section above. This is the feature that replaces all SQL-based permission management going forward.

---

## Architecture decisions

### Thin shell principle
The shell knows modules exist. It does not know what they do. Module logic lives inside its module folder. The shell only reads from `modules.config.js`.

### Module registry
All modules are declared in `src/modules.config.js`. The sidebar and home screen both read from this file. Adding a new module = adding one entry here. Nothing else in the shell changes.

### Layout route pattern
`AppShell` is a React Router layout route. It renders the persistent chrome (top bar + sidebar) and an `<Outlet />` for the active module. The Fee Engine's existing routes nest inside this outlet unchanged.

### Permissions
Permission flags live on `staff_profiles` in Supabase. The shell reads the current user's profile on login and stores it in context. Modules check flags from context — they do not re-query Supabase on every render.

---

## File structure to create

```
src/
├── modules.config.js          ← single source of truth for modules
├── shell/
│   ├── AppShell.jsx           ← layout route: sidebar + topbar + <Outlet>
│   ├── TopBar.jsx             ← persistent top bar
│   ├── Sidebar.jsx            ← module nav, generated from modules.config
│   ├── HomeScreen.jsx         ← role-personalised landing page
│   └── LoginPage.jsx          ← cinematic intro + login form
├── modules/
│   ├── fee-engine/            ← existing /manage/* routes move here
│   ├── reports/               ← new (stub for now)
│   ├── work-planner/          ← new (stub for now)
│   ├── pd-tracker/            ← new (stub for now)
│   └── ideas/                 ← moved from portal draft
├── admin/
│   └── StaffManagement.jsx    ← staff access + permission management
├── components/                ← shared UI components
│   ├── AttentionItem.jsx
│   ├── ModuleStatusBadge.jsx
│   ├── PermissionPill.jsx
│   └── ...
└── lib/                       ← existing supabase.js etc
```

Existing files under `src/components/`, `src/pages/`, `src/lib/` stay exactly where they are.

---

## modules.config.js spec

```js
export const MODULES = [
  {
    id: 'fee-engine',
    label: 'Fee Engine',
    route: '/manage',
    icon: 'receipt',
    permissions: ['can_view_quotes'],
    status: 'live',
    group: 'billing',
  },
  {
    id: 'reports',
    label: 'Reports',
    route: '/reports',
    icon: 'bar-chart-2',
    permissions: ['can_view_reports'],
    status: 'live',
    group: 'data',
  },
  {
    id: 'work-planner',
    label: 'Work planner',
    route: '/team/work',
    icon: 'clock',
    permissions: ['can_view_work_planner'],
    status: 'planned',
    group: 'team',
  },
  {
    id: 'pd-tracker',
    label: 'PD tracker',
    route: '/team/pd',
    icon: 'graduation-cap',
    permissions: ['can_view_pd_tracker'],
    status: 'planned',
    group: 'team',
  },
  {
    id: 'ideas',
    label: 'Ideas',
    route: '/ideas',
    icon: 'lightbulb',
    permissions: [],
    status: 'live',
    group: 'meta',
  },
];
```

Status rules for sidebar rendering:
- `live` + user has the required permission flag → fully clickable
- `live` + user lacks the required permission flag → hidden
- `planned` + user has `can_manage_portal = true` → visible but greyed, non-clickable, tooltip "Coming soon"
- `planned` + user lacks `can_manage_portal` → hidden

There is no `role` field. All access is controlled exclusively by permission flags on `staff_profiles`.
`can_manage_portal = true` is the flag that unlocks admin-level visibility (planned modules, staff management, etc.).

---

## Route structure

```
/              → redirect to /home (if authenticated) or /login
/login         → LoginPage
/home          → HomeScreen (protected)
/manage/*      → Fee Engine (existing routes, unchanged, protected)
/reports       → ReportsPage (requires can_view_reports)
/ideas         → IdeasPage (all active staff)
/team/work     → WorkPlannerPage (stub, future)
/team/pd       → PDTrackerPage (stub, future)
/admin/staff   → Staff Management (requires can_manage_portal)
```

---

## Permission model

All access control in the portal is driven exclusively by boolean flags on `staff_profiles`.
There is no `role` field. No hardcoded names. No special-casing of individuals in code.
Bobby grants and revokes flags through the Staff Management UI (spec below).

### Full permission flag set

| Flag | What it unlocks |
|---|---|
| `can_view_quotes` | See quotes list, quote detail, export PDF, preview |
| `can_edit_quotes` | Create, edit, submit, re-quote, delete (non-committed) |
| `can_approve_quotes` | Approve, reject, send, accept, revert, commit. Also unlocks Needs Attention and Stats on home screen |
| `can_edit_fee_schedule` | Pricing defaults editor, new versions |
| `can_view_reports` | Access the Reports module |
| `can_view_work_planner` | Access the Work Planner module (future) |
| `can_view_pd_tracker` | Access the PD Tracker module (future) |
| `can_manage_portal` | Staff Management UI, planned module visibility, portal admin functions |
| `is_active` | Whether the staff member can log in at all. Setting this to false is the off-switch |

`can_manage_portal` is the superuser flag. Anyone with it set to `true` can access the
Staff Management UI and modify other users' permissions. Bobby always has this.
It can be granted to any other staff member without touching code or SQL.

### Database additions required

```sql
alter table staff_profiles
  add column if not exists can_view_reports boolean default false,
  add column if not exists can_view_work_planner boolean default false,
  add column if not exists can_view_pd_tracker boolean default false,
  add column if not exists can_manage_portal boolean default false;
```

Do NOT add a `role` column. Do not reference `role` anywhere in the codebase.
Do not special-case any individual's name or email address in any component.

Note: `can_view_quotes`, `can_edit_quotes`, `can_approve_quotes`, `can_edit_fee_schedule`
already exist on `staff_profiles` from the Fee Engine. Do not recreate them.

### Supabase RLS

The existing `is_active_staff()` and `is_portal_admin()` SECURITY DEFINER functions
remain in place and are already correct. Do not recreate or modify them.

`is_portal_admin()` checks `can_manage_portal = true AND is_active = true` on
`staff_profiles`. The existing policies "Admins can manage staff profiles" (ALL)
and "Admins can view all staff profiles" (SELECT) already use this function,
meaning anyone with `can_manage_portal = true` can already read and update all
staff profiles. No new RLS policies are needed for the Staff Management UI.

---

## Staff Management UI

Route: `/admin/staff`
Visible in sidebar only when `can_manage_portal = true`.
Label in sidebar: "Staff" with a Users icon (Lucide `Users`).

### Page layout

Page heading: "Staff" (Playfair Display, 28px).
Subtitle: "Manage portal access and permissions." (14px, `#64748b`).

Full-width table of all staff members from `staff_profiles`, ordered by `full_name`.

### Staff table columns

| Column | Content |
|---|---|
| Name | `full_name` — 15px, 500 weight, `#0f172a` |
| Email | `email` — 13px, `#64748b` |
| Access | Toggle — `is_active`. Green when active, grey when inactive |
| Permissions | Row of permission pills (see below) |
| Actions | "Edit" button |

### Permission pills

Each permission flag is shown as a small pill on the staff row:
- Flag is `true`: filled pill, Electric Blue background `#38bdf815`, Electric Blue text, label is the short name (e.g. "Quotes", "Approve", "Reports", "Admin")
- Flag is `false`: not shown (absence is clean, not a grey pill)

Short labels for pills:

| Flag | Pill label |
|---|---|
| `can_view_quotes` | Quotes |
| `can_edit_quotes` | Edit quotes |
| `can_approve_quotes` | Approve |
| `can_edit_fee_schedule` | Fee schedule |
| `can_view_reports` | Reports |
| `can_view_work_planner` | Work planner |
| `can_view_pd_tracker` | PD tracker |
| `can_manage_portal` | Admin |

### Edit modal

Clicking "Edit" opens a modal (not a new page) for that staff member.

Modal contents:
- Staff name as heading (Playfair, 20px)
- Email (small, `#94a3b8`)
- Divider
- "Portal access" toggle — maps to `is_active`. Label: "Can log in". When toggled off, all other toggles grey out (they're moot if the person can't log in).
- Divider
- "Permissions" section — one toggle per flag, labelled clearly:

```
□ View quotes
□ Edit & create quotes
□ Approve & send quotes
□ Edit fee schedule
□ View reports
□ View work planner (coming soon)
□ View PD tracker (coming soon)
□ Portal admin (can manage staff access)
```

Toggles for `planned` module flags (`can_view_work_planner`, `can_view_pd_tracker`)
show a small grey "Coming soon" label next to them. They can still be toggled —
the permission is granted in advance, it just won't surface any UI yet.

- "Save changes" button — `background: #0f172a`, full width of modal
- "Cancel" link — closes modal without saving
- Saving updates `staff_profiles` via Supabase. Show a brief success toast on save.

### Safety rules

- A user cannot remove `can_manage_portal` from themselves. If they try, show:
  "You cannot remove your own admin access." Disable that specific toggle for the
  currently logged-in user's own edit modal.
- `is_active = false` does not delete the record. The staff member simply cannot log in.
  Their historical data (quotes created, report runs triggered) is preserved.
- No delete button. Deactivation (`is_active = false`) is the only off-switch.

### Invite new staff (phase 2 placeholder)

At the top right of the page: "Invite staff member" button — greyed out, tooltip
"Coming soon". Do not implement invite flow in this sprint. The button is a
visual placeholder only.

---

### New table: `ideas`
```sql
create table ideas (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  votes integer default 0,
  submitted_by uuid references staff_profiles(id),
  submitted_by_name text,
  created_at timestamptz default now()
);

alter table ideas enable row level security;

create policy "Active staff can read ideas"
  on ideas for select using (is_active_staff());

create policy "Active staff can insert ideas"
  on ideas for insert with check (is_active_staff());

create policy "Active staff can vote"
  on ideas for update using (is_active_staff());
```

---

## App shell layout spec

### Top bar (persistent, full width)
- Height: 56px
- Background: `#ffffff`, border-bottom: `1px solid #e5e7eb`
- Left: 32px gradient badge (`linear-gradient(135deg, #0a0a0a, #1a1a2e)`) with "A" in `#38bdf8` → "ATHENA" wordmark (14px, 600 weight, letter-spacing 0.08em, `#1a1a2e`) → breadcrumb (11px, `#94a3b8`) showing current module + page
- Right: notifications bell icon (Lucide `Bell`, 20px, `#94a3b8`, no functionality) → user avatar circle (32px, `#38bdf8` bg, white initials from `full_name` on `staff_profiles`) → AVA logo (28px, rounded 6px)
- Top bar padding: `12px 16px`

### Sidebar (collapsible)
- Width open: 240px. Width collapsed: 56px (icon only).
- Background: `#ffffff`, border-right: `1px solid #e5e7eb`
- Collapse toggle at bottom: chevron icon, toggles state
- Collapse state persisted to `localStorage` key `athena_sidebar_collapsed`
- Auto-collapses to icon-only on viewport < 1024px

Sidebar sections (top to bottom):
1. Module navigation — generated from `MODULES` filtered by permission + status rules above
2. Separator
3. Ideas (always visible to all active staff)
4. Staff Management link (only visible when `can_manage_portal = true`)
5. User profile row (name + email, small) — at very bottom

Active module: left accent bar `3px solid #38bdf8`, background `#38bdf815`.
Hover: background `#f8fafc`.
Planned (visible): `#94a3b8` text, no hover, cursor default, tooltip "Coming soon".

Module nav item anatomy:
- Icon (Lucide, 18px) + label (14px, 500 weight) when expanded
- Icon only (20px, centred) when collapsed, with tooltip showing label on hover
- Status badge: `beta` modules show a small amber pill "Beta" — do not show for `live` or `planned`

---

## Home screen spec

### Layout
Max-width 1080px, centred, padding `40px 24px`.

### Header row
- Left: "Good [morning/afternoon/evening], [first name]" — Playfair Display, 28px, 500 weight, `#0f172a`. First name from `staff_profiles.full_name`.
- Right: today's date (DD Month YYYY), small, `#94a3b8`

### "Needs attention" section
Shown when user has `can_approve_quotes = true` OR `can_manage_portal = true`.

No role check. If the flag is set, the section appears. If not, it doesn't.

Pulls from Supabase:
- Quotes with `status = 'awaiting_approval'` → show as attention items
- Quotes with `status = 'accepted'` and `valid_until` within 3 days → show as expiry warnings

Each attention item: white card, 12px radius, `1px solid #e5e7eb`, left accent `3px solid #f59e0b` (amber for pending), `3px solid #f87171` (red for expiring). Click navigates to the quote.

Empty state (all clear): green left accent, "Nothing needs your attention right now." — positive state, style it as such.

Maximum 5 items shown. If more, show "View all X pending" link.

### Stats row ("This week")
Shown when user has `can_approve_quotes = true` OR `can_manage_portal = true`.

Three stat cards in a row:
- Fees committed this week (£ from `live_billing.monthly_fee * 12` for records created this week)
- Quotes created this week (count from `quotes` where `created_at` >= start of current week)
- Quotes awaiting approval (count, links to quotes list filtered to awaiting_approval)

In Step 4 (structure only), hardcode these as `—` placeholders. Wire in Step 5.

### Module status strip
Compact horizontal strip showing modules from `modules.config.js`.
- `live`: filled Electric Blue dot + module label
- `planned`: hollow grey dot + module label (grey)
- `beta`: filled amber dot + module label

Each user sees only modules they have permission to access, plus planned modules
if they have `can_manage_portal = true`.

### Visibility summary
Every section is driven by permission flags — no role names, no hardcoded names.

| Section | Required flag |
|---|---|
| Needs attention | `can_approve_quotes` OR `can_manage_portal` |
| Stats row | `can_approve_quotes` OR `can_manage_portal` |
| Module status strip | visible to all; planned modules need `can_manage_portal` |
| Greeting | all active staff |

---

## Login page spec

### Cinematic intro
- Play once per session. Check `sessionStorage.getItem('athena_intro_shown')`. If set, skip to login form immediately.
- After intro completes, set `sessionStorage.setItem('athena_intro_shown', 'true')`.
- Intro sequence: black background → "ATHENA" text fades in (Major Mono Display, 62px) → 7 dots light up sequentially → 7th dot starburst → fade to login form.
- Full sequence: ~7 seconds. Fade out: 0.8s.
- "Powered by Almond Valley Accounting" label bottom-right, white 50% opacity, appears with the text.

The existing intro animation from the current portal draft is correct — reuse it exactly.

### Login form (appears after intro or immediately if returning)
- Full-screen dark background: `#000` to `#0a0a0f` (radial, subtle)
- Centred card: white, `border-radius: 16px`, `padding: 40px`, max-width 400px
- Contents top to bottom:
  - AVA logo (48px, centred)
  - "ATHENA" wordmark (Major Mono Display, 22px, centred, `#0f172a`)
  - 8px gap
  - Email input (full width, `border: 1px solid #e5e7eb`, `border-radius: 10px`, `padding: 12px 16px`)
  - Password input (same)
  - "Sign in" button (full width, `background: #0f172a`, white text, 600 weight, `border-radius: 10px`, `padding: 14px`)
  - Error message below button if auth fails (red, 13px)
- Loading state: button shows spinner, fields disabled

### Post-login redirect
All users → `/home` for now. Do not add role-based redirect logic in Step 1.

---

## Design system tokens

These are non-negotiable. All new UI must use these values.

### Colours
| Token | Value | Use |
|---|---|---|
| Electric Blue | `#38bdf8` | Primary accent, CTAs, active states |
| Baby Blue | `#7dd3fc` | Secondary accent, in-progress states |
| Page background | `#fafafa` | App background |
| Surface | `#ffffff` | Cards, sidebar, top bar |
| Text primary | `#0f172a` | Headings |
| Text secondary | `#1e293b` | Body |
| Text muted | `#64748b` | Descriptions |
| Text faint | `#94a3b8` | Metadata, labels |
| Border default | `#e5e7eb` | Cards, inputs, dividers |
| Border light | `#f1f5f9` | Inner separators |

### Typography
| Use | Font | Size | Weight |
|---|---|---|---|
| Splash title | Major Mono Display | 62px | 400 |
| Page headings h1/h2 | Playfair Display | 28–30px | 500 |
| Section labels | Outfit | 13px | 600, uppercase |
| UI text, body | Outfit | 13–15px | 400–600 |
| Stat values | Outfit | 28px | 700 |
| Top bar wordmark | Outfit | 14px | 600, tracking 0.08em |
| Buttons | Outfit | 12–14px | 600 |

Google Fonts import:
```
https://fonts.googleapis.com/css2?family=Major+Mono+Display&family=Playfair+Display:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700&display=swap
```

Major Mono Display is reserved exclusively for the "ATHENA" branding mark. Never use it for anything else.

### Border radius
| Element | Radius |
|---|---|
| Cards | `12px` |
| Large tiles | `16px` |
| Inputs | `10px` |
| Buttons | `10px` |
| Badges | `8px` |

### Transitions
All interactive elements: `transition: all 0.2s ease`.
Card hover: `translateY(-2px)`, `box-shadow: 0 8px 24px {accent}12`.

---

## Do not do list

- Do not refactor, rename, or move any existing Fee Engine files
- Do not install new dependencies without checking first — ask if a package isn't already in `package.json`
- Do not add a testing framework or test files unless explicitly instructed
- Do not add ESLint or Prettier config changes
- Do not add dark mode — light mode only, the design system does not include dark mode
- Do not create a separate Supabase project — use `neksyvneljgxvpchwgch`
- Do not change any existing Supabase RLS policies
- Do not create a separate Vercel project — the existing deployment handles everything
- Do not add micro-frontend architecture — this is a single repo, single deployment
- Do not add global state management libraries (Redux, Zustand etc.) — use React context for shell state, Supabase queries for everything else
- Do not add animations beyond what is specified — no framer-motion, no GSAP
- Do not use `<form>` tags — use `onClick` handlers and controlled inputs throughout
- Do not commit directly to `main` — use a branch `feature/portal-shell` and describe what to PR when done

---

## Where to start

```
Step 1: Auth shell.
Create src/shell/LoginPage.jsx and src/shell/AppShell.jsx.
Wire Supabase session check.
Redirect to /home on login, /login when unauthenticated.
Do not build anything else until login → /home works end-to-end.
Ask before installing any packages not already in package.json.
```

---

## Key contacts / ownership

- **Owner:** Bobby Gallacher (bobby@almondvalleyaccounting.co.uk)
- **Supabase project:** `neksyvneljgxvpchwgch`
- **GitHub:** `almondvalleyaccounting/athena-portal`
- **Live URL:** `portal.almondvalleyaccounting.co.uk`
- **Vercel project:** `athena-portal`
