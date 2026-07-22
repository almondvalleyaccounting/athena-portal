# Recruitment module — future work log

_Last updated: 2026-07-22. Owner: Bobby. Built by Claude across three sessions._

The Recruitment module is an **in-house ATS** for hiring firm staff. Phases 1–6
are built and pushed to `master` (commits `28c148b`, `55e0330`). This log tracks
what's left — the deferred phases, the things that need a human, and the known
gaps — so we can pick it up cold.

## The one hard rule (never relax)
**Zero risk of any non-AVA-staff getting into Athena.** No public surface may
share Athena's Supabase project, anon key, domain, or session. Applications flow
*toward* Athena only through staff-controlled channels (email into `jobs@`, or
manual entry). Any careers page lives in a **separate, isolated project**.

---

## 1. Needs a human before it works (blocking)

### 1a. `jobs@` mailbox — Google Workspace admin (Bobby)
Recruitment is periodic, so avoid a paid licence. Two zero-cost options:
- **Alias of info@** — simplest; applicant mail lands in the shared info@ inbox.
- **Google Group `jobs@` (recommended)** — members = hiring managers only,
  allow external senders to post, deliver into `bobby@` (already a live Gmail
  connection). Keeps applicant PII out of the shared info@ inbox (matches the
  tight-PII decision).
- Also configure a **send-as** for `jobs@` so replies go out from it.

### 1b. Resend / reply-to env (verify)
The `recruitment-email` edge function sends via Resend. Confirm:
- `RESEND_FROM_EMAIL` / `RESEND_FROM_NAME` are what we want applicants to see.
- `RECRUITMENT_REPLY_TO` (defaults to `info@…`) points where replies should land
  — set to `jobs@…` once 1a is done.

### 1c. Live smoke-test (Bobby, on a logged-in session)
Nothing has been interactively tested — the build sandbox can't authenticate to
Athena. First real use of the email tab sends a **real email**. Walk through:
create a vacancy → add applicant → drag across stages → send a test email/SMS →
schedule an interview (+ .ics) → draft an offer/contract → start induction.

### 1d. Admin permission toggles (small dev task)
Three flags exist on `staff_profiles` but there's **no Admin UI** to grant them —
only `can_manage_portal` owners are seeded. Add toggles on the Admin/user screen
for: `can_view_recruitment`, `can_view_recruitment_applicants`,
`can_manage_recruitment`. (Two tiers: view-pipeline vs see-applicant-PII.)

---

## 2. Deferred phases (agreed, not yet built)

### P4 — Live email intake (`jobs@` → pipeline)
Blocked on 1a. When ready: add a routing hook so mail delivered to `jobs@` is
turned into a `recruitment_candidates` + `recruitment_applications` row instead
of a client comm. Options: extend the shared `comms-ingest` edge function
(⚠️ diff deployed vs repo first — known divergence risk), or a dedicated
`recruitment-intake` function. Match applicant to an open vacancy (by subject/
address tag), find-or-create candidate by email, drop the CV attachment into a
private storage bucket (see 3a), and log the original email to
`recruitment_messages` (direction `in`).

### P7 — Reed Recruiter API (optional, needs paid account)
Only real two-way job-board API viable for a UK firm. HMAC-SHA1 auth via a
`recruitment-reed` edge fn + a service-role `reed_config` table (mirror
`telnyx_config`). Post/edit/end jobs + CV search. Data model already anticipates
it: `recruitment_adverts.channel = 'reed'` + `external_ref` (the Reed job id).
Adzuna (free) is the salary-benchmark companion — read-only, no posting.

### Careers microsite (Option B — separate repo)
Branded public careers page. **Its own repo + domain**
(e.g. `careers.almondvalleyaccounting.co.uk`), **no access to Athena's Supabase
project/keys/session — ever.** One-way flows only: Athena → microsite (outbound
push of *published* vacancies), microsite → email (`jobs@`) for applications.
Being public-and-not-Athena, it can safely carry schema.org `JobPosting` JSON-LD
→ free Google for Jobs distribution + a sitemap. Like WCT / the childcare app,
a separate project.

---

## 3. Known gaps / polish (within Athena)

- **3a. CV file storage.** Today `cv_url` is a link (Drive/URL). Add a private
  Supabase Storage bucket for uploaded CVs, RLS-gated to
  `can_view_recruitment_applicants`. Needed properly by P4 (email attachments).
- **3b. E-signature.** Offer/Contract tabs track status + a document link only.
  Full e-sign can reuse the client-portal document flow in a later pass.
- **3c. Google Calendar push.** Interviews currently generate a downloadable
  `.ics` (deliberately backend-free). A real GCal push would need calendar OAuth
  in an edge function — only if manual .ics proves too fiddly.
- **3d. Induction → staff record.** "Create staff account & logins" is a manual
  checklist item by design (most sensitive action given the hard rule). If ever
  automated, it must stay an explicit, permissioned, human-triggered action —
  never automatic.
- **3e. Email templates.** Presets are hard-coded in `recruitmentShared.js`
  (`EMAIL_TEMPLATES`). If Bobby wants editable copy, move them to a DB table
  (or reuse `comm_templates`) with a manager editor — like the reminders flow.
- **3f. Interview reminders.** No automated reminder to candidate/interviewers
  before an interview. Could ride the comms stack later.
- **3g. Reporting.** No time-to-hire / source-effectiveness / pipeline-funnel
  metrics yet. Candidate for a later dashboard tab.

---

## Reference — what exists now
- **DB:** `sql/155` (candidates, vacancies, adverts, applications, notes +
  2-tier RLS + 3 permission flags); `sql/156` (messages, interviews, offers,
  contracts, induction_items — all PII tier).
- **Edge fn:** `recruitment-email` (Resend; `verify_jwt` off, self-checks staff
  + PII clearance; logs to `recruitment_messages`). SMS reuses the shared
  `sms-send` (unchanged) + mirrors a `recruitment_messages` row.
- **Frontend:** `src/modules/recruitment/` — `RecruitmentModule` (tabs), views
  `VacanciesView` / `VacancyDetailView` / `InterviewsView`, components
  `PipelineBoard` (dnd-kit kanban) / `ApplicationDrawer` (6 tabs) /
  `AddApplicationModal` / `VacancyFormModal` / `drawer/*` panels.
- **Nav:** `modules.config.js` (team group, `can_view_recruitment`), route
  `/recruitment/*` in `main.jsx`, `user-check` icon in `Sidebar.jsx`.
