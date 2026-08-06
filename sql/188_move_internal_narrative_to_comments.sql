-- 188: Move internal narrative off five bills' line descriptions and into
-- billing_item_comments (sql/185).
--
-- Why: supabase/functions/qbo-push-billing-items sends the line description
-- straight through as the QuickBooks invoice line Description —
--
--     Description: l.description || l.service
--
-- so anything typed there prints on the client's invoice. On these five bills
-- the team had used it as a notepad: how long a job took, what the client had
-- got wrong, who kept emailing, an open question about whether something was
-- already billed. None of that is for the client to read.
--
-- Now that a bill has an internal comment thread there's a right place for it.
-- Each original text is preserved verbatim as a comment attributed to the
-- person who raised the bill (billing_items.created_by), and the description is
-- replaced with a short client-facing line. Wording confirmed with Bobby
-- 2026-08-06 — what prints on an invoice is a commercial decision, not a
-- mechanical rewrite.
--
-- Note the text lives in billing_items.lines[n].description, not the top-level
-- billing_items.description column (null on all five), so each fix is a
-- jsonb_set on one element of the lines array.
--
-- Both halves are guarded and idempotent: the insert skips if that comment is
-- already there, and the update only fires while the description still holds
-- the original text — so re-running this can't clobber a later edit.
--
-- NOT fixed here, flagged to Bobby separately: two of these bills carry a
-- service line that contradicts what the work actually was (McCrorie is on
-- Self Assessment for bookkeeping work; Trefoil is on Business Accounts - Ltd
-- Companies for payroll rework). The service name is what resolves to the QBO
-- item, so the invoice would show the wrong product no matter what the
-- description says. That needs a decision about which field is wrong.

-- ── 1. McCrorie, Gordon — raised by Lisa Quinn ───────────────────────────────

insert into public.billing_item_comments (billing_item_id, author_id, body)
select '7d237a70-cd15-4c36-bfd1-529926f82372', b.created_by,
       'MTD - Bank hadn''t been reconciled since April 2025.  Took around 1 hour to reconcile as Gordon had excluded quite a lot which I wasn''t aware of and created duplicate transfers for the credit card payments which needed deleted.'
from public.billing_items b
where b.id = '7d237a70-cd15-4c36-bfd1-529926f82372'
  and not exists (
    select 1 from public.billing_item_comments c
    where c.billing_item_id = b.id and c.body like 'MTD - Bank hadn''t been reconciled%'
  );

update public.billing_items
set lines = jsonb_set(lines, '{0,description}',
      to_jsonb('MTD — additional bookkeeping, bank reconciliation (1 hour)'::text))
where id = '7d237a70-cd15-4c36-bfd1-529926f82372'
  and lines->0->>'description' like 'MTD - Bank hadn''t been reconciled%';

-- ── 2. Trefoil Energy Systems Ltd — raised by Lisa Quinn ─────────────────────

insert into public.billing_item_comments (billing_item_id, author_id, body)
select 'acaf071c-87b5-4f0d-92af-fea716c992f5', b.created_by,
       'Payroll - rework on June and July''s payroll as had been paying employee but only told us 5th August.'
from public.billing_items b
where b.id = 'acaf071c-87b5-4f0d-92af-fea716c992f5'
  and not exists (
    select 1 from public.billing_item_comments c
    where c.billing_item_id = b.id and c.body like 'Payroll - rework on June and July%'
  );

update public.billing_items
set lines = jsonb_set(lines, '{0,description}',
      to_jsonb('Payroll — additional processing, June and July 2026'::text))
where id = 'acaf071c-87b5-4f0d-92af-fea716c992f5'
  and lines->0->>'description' like 'Payroll - rework on June and July%';

-- ── 3. Black, Marcus — raised by Margaret Loughrey ───────────────────────────
--
-- The mildest of the five: the description was already close to client-facing,
-- and the "6 hours" is carried by the line's own qty 6 @ £45 rather than typed
-- into the text. Preserved as a comment anyway so the thread shows what was
-- originally entered, and the shorthand dates spelled out. Line 1 of 2 — line 2
-- ("Sole Trader Accounts - 2025/26") is left alone.

insert into public.billing_item_comments (billing_item_id, author_id, body)
select '25736a82-18da-41ed-b147-1eb817817526', b.created_by,
       'Bank reconciliation May25-Mar26 by month'
from public.billing_items b
where b.id = '25736a82-18da-41ed-b147-1eb817817526'
  and not exists (
    select 1 from public.billing_item_comments c
    where c.billing_item_id = b.id and c.body = 'Bank reconciliation May25-Mar26 by month'
  );

update public.billing_items
set lines = jsonb_set(lines, '{0,description}',
      to_jsonb('Bank reconciliation, May 2025 to March 2026'::text))
where id = '25736a82-18da-41ed-b147-1eb817817526'
  and lines->0->>'description' = 'Bank reconciliation May25-Mar26 by month';

-- ── 4. Big Al Events Ltd — raised by Lisa Quinn ──────────────────────────────
--
-- Named the client's own people (Kirsty & Al) and how long their emails took.
-- Fine internally, needlessly pointed on an invoice.

insert into public.billing_item_comments (billing_item_id, author_id, body)
select 'd71ff4b0-f37e-4e02-9d34-c4f0d64f146d', b.created_by,
       'June - 90 minutes additional help with email queries from Kirsty & Al'
from public.billing_items b
where b.id = 'd71ff4b0-f37e-4e02-9d34-c4f0d64f146d'
  and not exists (
    select 1 from public.billing_item_comments c
    where c.billing_item_id = b.id and c.body like 'June - 90 minutes additional help%'
  );

update public.billing_items
set lines = jsonb_set(lines, '{0,description}',
      to_jsonb('Additional support — accounting queries, June 2026 (1.5 hours)'::text))
where id = 'd71ff4b0-f37e-4e02-9d34-c4f0d64f146d'
  and lines->0->>'description' like 'June - 90 minutes additional help%';

-- ── 5. McManus And Sons Ltd — raised by Stephanie Campbell ───────────────────
--
-- The parenthetical here isn't narrative, it's an unanswered question —
-- Stephanie wasn't sure whether the rework had already been charged in week 3.
-- That's exactly what the comment thread is for, and it wants an answer before
-- this bill goes anywhere.

insert into public.billing_item_comments (billing_item_id, author_id, body)
select '5bacea89-8598-483b-8eff-7530d162247a', b.created_by,
       E'26.27 - Week 1-12\n25.26 - Week 3-52 (I believe he was charged the rework at the beginning of week 3)'
from public.billing_items b
where b.id = '5bacea89-8598-483b-8eff-7530d162247a'
  and not exists (
    select 1 from public.billing_item_comments c
    where c.billing_item_id = b.id and c.body like '26.27 - Week 1-12%'
  );

update public.billing_items
set lines = jsonb_set(lines, '{0,description}',
      to_jsonb('Payroll — 2025/26 weeks 3–52 and 2026/27 weeks 1–12'::text))
where id = '5bacea89-8598-483b-8eff-7530d162247a'
  and lines->0->>'description' like '26.27 - Week 1-12%';
