-- ============================================================
-- CH personal-code emails — turn the "gov.uk" mentions into a real clickable
-- link to the Companies House self-verification page, so clients who choose to
-- verify themselves have one tap to the right place. Applied to the three
-- templates that offer self-verification: offer, decision reminder, self-verify
-- reminder. Idempotent (replace() no-ops once the <a> is in place); templates
-- are user-editable so this only patches the stock copy.
-- ============================================================

update ch_code_email_templates set
  body_html = replace(body_html,
    'Verify at gov.uk using GOV.UK One Login',
    'Verify at <a href="https://www.gov.uk/guidance/verify-your-identity-for-companies-house" style="color:#1155cc;">gov.uk using GOV.UK One Login</a>'),
  updated_at = now()
where key = 'offer';

update ch_code_email_templates set
  body_html = replace(body_html,
    'verify yourself at gov.uk',
    'verify yourself at <a href="https://www.gov.uk/guidance/verify-your-identity-for-companies-house" style="color:#1155cc;">gov.uk</a>'),
  updated_at = now()
where key = 'reminder';

update ch_code_email_templates set
  body_html = replace(body_html,
    'you can do it at gov.uk using GOV.UK One Login',
    'you can do it at <a href="https://www.gov.uk/guidance/verify-your-identity-for-companies-house" style="color:#1155cc;">gov.uk using GOV.UK One Login</a>'),
  updated_at = now()
where key = 'self_verify';
