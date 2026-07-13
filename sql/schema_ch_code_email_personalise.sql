-- ============================================================
-- CH personal-code emails — make them read as a personal note, not a
-- system template. Greeting uses first name only ({{first_name}}), bodies are
-- plain typed paragraphs (no branded card — see emailRender.js wrapShell), and
-- an editable signature (Sophie by default) is appended at render time.
-- Still sent via Resend from the firm address.
-- ============================================================

alter table ch_code_chase_config add column if not exists email_signature_html text;

update ch_code_chase_config
   set email_signature_html = $sig$<p style="margin:18px 0 0;">Best wishes,<br>Sophie</p>
<p style="margin:12px 0 0;color:#555;font-size:13px;line-height:1.5;">Sophie Laidlaw<br>Almond Valley Accounting<br><a href="mailto:sophie@almondvalleyaccounting.co.uk" style="color:#555;text-decoration:none;">sophie@almondvalleyaccounting.co.uk</a></p>$sig$
 where id = true and (email_signature_html is null or email_signature_html = '');

-- Plain, first-name bodies.
update ch_code_email_templates set body_html = $q$<p style="margin:0 0 12px;">Hi {{first_name}},</p>
<p style="margin:0 0 12px;">Companies House now requires every company director and person with significant control to verify their identity and get a personal code before we can file {{entity}}'s next Confirmation Statement.</p>
<p style="margin:0 0 12px;">There are two ways to sort it:</p>
<p style="margin:0 0 12px;"><strong>1. We do it for you — £20 + VAT.</strong> Send us a photo ID and a recent proof of address and we'll verify your identity as your agent. Just reply and let me know.</p>
<p style="margin:0 0 12px;"><strong>2. You do it yourself — free.</strong> Verify at gov.uk using GOV.UK One Login, then send us the personal code it gives you.</p>
<p style="margin:0 0 12px;">Either way, Companies House emails the code to your own inbox (never to us), so we'll always need you to forward it on once you have it.</p>
<p style="margin:0 0 12px;">Just reply and let me know which you'd prefer.</p>$q$ where key = 'offer';

update ch_code_email_templates set body_html = $q$<p style="margin:0 0 12px;">Hi {{first_name}},</p>
<p style="margin:0 0 12px;">Just a quick nudge on your Companies House identity verification for {{entity}} — could you let me know whether you'd like us to handle it for you (£20 + VAT, with your ID and proof of address), or you'd rather verify yourself at gov.uk?</p>
<p style="margin:0 0 12px;">Whenever you get a moment, just hit reply. Thanks!</p>$q$ where key = 'reminder';

update ch_code_email_templates set body_html = $q$<p style="margin:0 0 12px;">Hi {{first_name}},</p>
<p style="margin:0 0 12px;">Thanks for letting me know you'll verify your own identity for Companies House. When you have a few minutes, you can do it at gov.uk using GOV.UK One Login.</p>
<p style="margin:0 0 12px;">Companies House will email your personal code straight to you once you're verified — please forward it on to me when it arrives and I'll get {{entity}}'s Confirmation Statement sorted.</p>
<p style="margin:0 0 12px;">If you'd rather we handled it for you instead (£20 + VAT), just say the word.</p>$q$ where key = 'self_verify';

update ch_code_email_templates set body_html = $q$<p style="margin:0 0 12px;">Hi {{first_name}},</p>
<p style="margin:0 0 12px;">Thanks for asking us to handle your Companies House identity verification. To get started I just need two things from you:</p>
<p style="margin:0 0 6px;">• A photo ID (passport or driving licence)</p>
<p style="margin:0 0 12px;">• A recent proof of address (utility bill or bank statement from the last 3 months)</p>
<p style="margin:0 0 12px;">Just reply with those two attached and I'll take it from there for {{entity}}.</p>$q$ where key = 'id_poa';

update ch_code_email_templates set body_html = $q$<p style="margin:0 0 12px;">Hi {{first_name}},</p>
<p style="margin:0 0 12px;">Once Companies House has verified your identity they'll email your personal code straight to you. As soon as it lands, could you forward it on to me? That's the last thing I need to file {{entity}}'s Confirmation Statement.</p>
<p style="margin:0 0 12px;">Thanks!</p>$q$ where key = 'code';
