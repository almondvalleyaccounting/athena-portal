-- Client-communication email templates. One row per (comm_type, kind).
-- Editable in Communications → Client Reminders → "Email templates"
-- (managers only) and rendered live by the reminders-send edge function,
-- which is now the SINGLE source of the copy — there is no hardcoded
-- fallback, so this table must always hold the two tax-reminder rows.
--
-- Tokens (substituted at send time): {{first_name}} {{amount}}
-- {{due_date}} {{payment_ref}} {{opt_in_url}} {{opt_out_url}} {{pay_url}}
-- (how to pay) {{pta_url}} (HMRC personal tax account — view balance).
-- Dynamic values are HTML-escaped into body_html; body_text/subject are
-- rendered raw. body_html is the INNER html (wrapped in the plain email
-- shell by the sender).

create table if not exists public.comm_templates (
  id           uuid primary key default gen_random_uuid(),
  comm_type    text not null references public.comm_types(id),
  kind         text not null check (kind in ('promo', 'reminder')),
  subject      text not null default '',
  body_html    text not null default '',
  body_text    text not null default '',
  updated_by   uuid references public.staff_profiles(id),
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (comm_type, kind)
);

alter table public.comm_templates enable row level security;

-- Staff read; managers (can_manage_portal / is_portal_admin) write —
-- same gate as the Client Reminders module send path.
drop policy if exists comm_templates_read on public.comm_templates;
create policy comm_templates_read on public.comm_templates
  for select using (public.is_active_staff());

drop policy if exists comm_templates_write on public.comm_templates;
create policy comm_templates_write on public.comm_templates
  for all
  using (exists (
    select 1 from public.staff_profiles p
    where p.id = auth.uid() and (p.can_manage_portal or p.is_portal_admin)
  ))
  with check (exists (
    select 1 from public.staff_profiles p
    where p.id = auth.uid() and (p.can_manage_portal or p.is_portal_admin)
  ));

-- ── Seed: the two tax-reminder templates ──────────────────────────────
-- Email 1 (promo)   — generic reminder + HMRC-account pointer + opt-in,
--                     NO figure (data protection).
-- Email 2 (reminder)— return figure + HMRC Cumbernauld bank details +
--                     payment reference (UTR + K) + "may differ from HMRC"
--                     caveat, to opted-in clients only.
insert into public.comm_templates (comm_type, kind, subject, body_html, body_text)
values
  (
    'tax_reminders', 'promo',
    'Your July self assessment payment — a quick heads-up',
    $html$<p style="margin:0 0 14px;">Hi {{first_name}},</p>
<p style="margin:0 0 14px;">If you make Self Assessment payments on account, your next one is due by <strong>31 July</strong>. You can review your tax position &mdash; your current balance and the payments you&rsquo;ve made &mdash; in your HMRC personal tax account at <a href="{{pta_url}}" style="color:#0e7fe0;">{{pta_url}}</a>.</p>
<p style="margin:0 0 14px;">We can also email you the payment amount from your tax return, along with HMRC&rsquo;s bank details and your payment reference. Because that includes your personal tax figures, we&rsquo;d like your OK first.</p>
<div style="margin:18px 0;">
  <a href="{{opt_in_url}}" style="display:inline-block;padding:10px 20px;background:#0e7fe0;color:#ffffff;text-decoration:none;border-radius:6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;">Yes &mdash; send me the details</a>
  <a href="{{opt_out_url}}" style="display:inline-block;padding:10px 20px;background:#ffffff;color:#444444;border:1px solid #cccccc;text-decoration:none;border-radius:6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;margin-left:10px;">No thanks</a>
</div>
<p style="margin:0 0 14px;">If the buttons don&rsquo;t work, just reply to this email with yes or no and we&rsquo;ll set it for you.</p>
<p style="margin:18px 0 0;">Thanks,<br/>Almond Valley Accounting</p>$html$,
    $txt$Hi {{first_name}},

If you make Self Assessment payments on account, your next one is due by 31 July. You can review your tax position — your current balance and the payments you've made — in your HMRC personal tax account at {{pta_url}}.

We can also email you the payment amount from your tax return, along with HMRC's bank details and your payment reference. Because that includes your personal tax figures, we'd like your OK first.

Yes — send me the details: {{opt_in_url}}
No thanks: {{opt_out_url}}

If the links don't work, just reply to this email with yes or no and we'll set it for you.

Thanks,
Almond Valley Accounting$txt$
  ),
  (
    'tax_reminders', 'reminder',
    'Your July self assessment payment — amount and how to pay',
    $html$<p style="margin:0 0 14px;">Hi {{first_name}},</p>
<p style="margin:0 0 14px;">Based on your latest tax return, your payment on account due by <strong>{{due_date}}</strong> is <strong>&pound;{{amount}}</strong>.</p>
<p style="margin:0 0 14px;">Please note this is the figure from your return. What HMRC actually shows can differ if you have overdue amounts, penalties or interest from late payments &mdash; you can review your balance in your HMRC personal tax account at <a href="{{pta_url}}" style="color:#0e7fe0;">{{pta_url}}</a>.</p>
<p style="margin:0 0 6px;"><strong>How to pay by bank transfer</strong></p>
<table style="border-collapse:collapse;margin:0 0 14px;font-size:14px;color:#222222;">
  <tr><td style="padding:2px 16px 2px 0;">Account name</td><td style="padding:2px 0;"><strong>HMRC Cumbernauld</strong></td></tr>
  <tr><td style="padding:2px 16px 2px 0;">Sort code</td><td style="padding:2px 0;"><strong>08 32 10</strong></td></tr>
  <tr><td style="padding:2px 16px 2px 0;">Account number</td><td style="padding:2px 0;"><strong>12001039</strong></td></tr>
  <tr><td style="padding:2px 16px 2px 0;">Payment reference</td><td style="padding:2px 0;"><strong>{{payment_ref}}</strong></td></tr>
</table>
<p style="margin:0 0 14px;">For other ways to pay, see <a href="{{pay_url}}" style="color:#0e7fe0;">{{pay_url}}</a>.</p>
<p style="margin:0 0 14px;">If you&rsquo;ve already paid, please ignore this. If anything looks wrong or you&rsquo;d like to talk it through, just reply.</p>
<p style="margin:18px 0 0;">Thanks,<br/>Almond Valley Accounting</p>$html$,
    $txt$Hi {{first_name}},

Based on your latest tax return, your payment on account due by {{due_date}} is £{{amount}}.

Please note this is the figure from your return. What HMRC actually shows can differ if you have overdue amounts, penalties or interest from late payments — you can review your balance in your HMRC personal tax account at {{pta_url}}.

How to pay by bank transfer:
  Account name:      HMRC Cumbernauld
  Sort code:         08 32 10
  Account number:    12001039
  Payment reference: {{payment_ref}}

For other ways to pay, see {{pay_url}}.

If you've already paid, please ignore this. If anything looks wrong or you'd like to talk it through, just reply.

Thanks,
Almond Valley Accounting$txt$
  )
on conflict (comm_type, kind) do nothing;
