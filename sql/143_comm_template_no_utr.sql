-- 143: third reminder template kind 'no_utr'. For a client who will owe a
-- payment on account but has no UTR because their Self Assessment isn't
-- registered/filed yet — HMRC has no record, so there's nothing to pay and
-- no reference. The email flags the coming payment and asks the client for
-- what's needed to get them registered. No bank details, no reference.

alter table public.comm_templates drop constraint if exists comm_templates_kind_check;
alter table public.comm_templates
  add constraint comm_templates_kind_check check (kind in ('promo', 'reminder', 'no_utr'));

insert into public.comm_templates (comm_type, kind, subject, body_html, body_text)
values (
  'tax_reminders', 'no_utr',
  'Your Self Assessment — we need to get you set up',
  $html$<p style="margin:0 0 14px;">Hi {{first_name}},</p>
<p style="margin:0 0 14px;">Based on your latest tax return, you&rsquo;re due to make a payment on account of around <strong>&pound;{{amount}}</strong> by <strong>{{due_date}}</strong>.</p>
<p style="margin:0 0 14px;">Before that can be paid, we need to finish setting up your Self Assessment with HMRC. At the moment HMRC has no record of it, so there is nothing to pay yet and no payment reference &mdash; but the payment will become due once you&rsquo;re registered.</p>
<p style="margin:0 0 14px;">To move this forward we need a little more from you. Please reply to this email and we&rsquo;ll tell you exactly what we need; once you&rsquo;re set up we&rsquo;ll send the amount and how to pay.</p>
<p style="margin:0 0 14px;">You can review your tax position anytime in your HMRC personal tax account at <a href="{{pta_url}}" style="color:#0e7fe0;">{{pta_url}}</a>.</p>
<p style="margin:18px 0 0;">Thanks,<br/>Almond Valley Accounting</p>$html$,
  $txt$Hi {{first_name}},

Based on your latest tax return, you're due to make a payment on account of around £{{amount}} by {{due_date}}.

Before that can be paid, we need to finish setting up your Self Assessment with HMRC. At the moment HMRC has no record of it, so there is nothing to pay yet and no payment reference — but the payment will become due once you're registered.

To move this forward we need a little more from you. Please reply to this email and we'll tell you exactly what we need; once you're set up we'll send the amount and how to pay.

You can review your tax position anytime in your HMRC personal tax account at {{pta_url}}.

Thanks,
Almond Valley Accounting$txt$
)
on conflict (comm_type, kind) do nothing;
