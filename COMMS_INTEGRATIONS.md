# Connecting all our comms to Athena — what's involved

*Written 20 July 2026, covering: multiple email addresses (item 11), Telnyx / Clerk SMS / WhatsApp (item 13), and how the two combine into automated escalations for triage clients (item 14).*

## Where we are today

Everything goes through **info@almondvalleyaccounting.co.uk**, via two routes:

1. **Resend** (an email API) sends all automated mail — chasers, digests, quote emails — *as* info@. It's fast and reliable, but messages are "from a system": they don't sit in the info@ Sent folder, and replies land in the info@ inbox where Athena's reply-scanner picks them up.
2. **The Gmail connection** (one mailbox: info@) lets Athena read the inbox, create drafts, and — as of today's changes — send real Gmail messages and archive processed mail. The client reminders feature uses this, so those emails are indistinguishable from a typed email.

## Option A — more Gmail mailboxes (recommended first step)

The `gmail_connections` table currently allows **one active connection**; that's a deliberate constraint, not a technical limit. To connect bobby@, tracy@, sophie@ etc.:

- Remove the one-active-row constraint and key connections by mailbox address.
- Each person clicks "Connect" once in Settings → Connections and approves the Google consent screen for their own mailbox (the OAuth app already exists; each mailbox gets its own refresh token).
- Every sending feature then takes a "send as" parameter: onboarding chasers could come from Sophie, fee conversations from Bobby, tax reminders from info@.
- The reply-scanner runs per-mailbox, so replies route back to the feature that sent the email regardless of which address it went to.

**Effort:** small-to-medium — a schema tweak, a loop in the reply-scanner, a "from" picker on sending features, and each person clicking Connect once. No new services, no new costs.

**One decision needed:** for each automated email type, which address it comes from. Worth a 10-minute list before building.

## Option B — Google Workspace domain-wide delegation

A service account that can act as *any* mailbox on the domain without individual consent. Cleaner at scale but requires Workspace super-admin setup, is a much bigger security surface (one key = every mailbox), and is overkill at 5-10 staff. Not recommended now.

## Resend's role going forward

Keep Resend for genuinely system-ish mail (portal login codes, internal digests, notifications to staff). Move client-facing conversational mail to Gmail sending progressively — it threads properly, lives in Sent, and replies behave naturally.

## Telnyx / Clerk SMS / WhatsApp (item 13)

Today: the WhatsApp number lives at **Telnyx** (the carrier), and **Clerk SMS** bridges it (plus SMS) into MS Teams. Two integration routes:

1. **Direct to Telnyx (recommended).** Telnyx has a clean REST API + webhooks. Athena gets its own Telnyx API key for the same number:
   - *Outbound:* an edge function `sms-send` posts to Telnyx (SMS and WhatsApp use the same Messages API, different `type`).
   - *Inbound:* a Telnyx webhook → new edge function `telnyx-inbound` → messages logged against the client (matched by phone number on `entities`/`people`), staff notified.
   - Clerk SMS keeps working unchanged in Teams — both can be attached to the same number, though we'd want to decide which system is the "primary" responder so clients don't get two half-conversations.
   - WhatsApp caveat: outside a 24-hour window from the client's last message, WhatsApp requires pre-approved templates ("Your accounts are due — reply YES to confirm...") which need registering with Meta via Telnyx. SMS has no such restriction — escalations should default to SMS first.
2. **Via Clerk SMS**, if it exposes an API/webhooks. Keeps one integration point but adds a dependency on a smaller product; worth checking their docs before ruling in/out.

**Effort (direct Telnyx, SMS only):** medium — one send function, one webhook function, a phone-number match on clients, and a message log table + thread UI. WhatsApp templates add admin overhead but no real code.

## How this enables triage escalations (item 14)

Once cases sit on the Triage Board with next actions and target dates, escalation becomes a ladder the nightly jobs can climb automatically:

1. Day 0: case opened → email from the relevant *person's* mailbox (feels personal, not system).
2. Day 5, no reply (the reply-scanner knows): follow-up email, different wording.
3. Day 10: SMS via Telnyx — "We've emailed a couple of times about X, could you give us a call?"
4. Day 14: case flagged urgent on the admin task list + on your home page for a phone call.

Every rung is just: a cron job reading open triage cases + their notes/dates, and a channel to send through. The channels are Options A and the Telnyx piece above; the ladder logic itself is a day's work once they exist. The same machinery later powers CH-code chases and onboarding nudges over SMS.

## Suggested order

1. Multi-mailbox Gmail (Option A) — unlocks personal-feeling automated email.
2. Telnyx SMS send + inbound log — one number, no WhatsApp templates yet.
3. Escalation ladder on triage cases using 1+2.
4. WhatsApp templates once the SMS ladder proves itself.
