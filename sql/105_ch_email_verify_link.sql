-- ============================================================
-- CH personal-code emails — turn the "gov.uk" mentions into a real clickable
-- link to the Companies House self-verification page, so clients who choose to
-- verify themselves have one tap to the right place. Applied to the three
-- templates that offer self-verification: offer, decision reminder, self-verify
-- reminder. Idempotent (replace() no-ops once the <a> is in place); templates
-- are user-editable so this only patches the stock copy.
--
-- Links carry target="_blank" so they open in a new tab — needed because the
-- Templates preview renders inside an iframe and gov.uk refuses to be framed
-- (X-Frame-Options), and because you never want to navigate a client away from
-- their inbox. The follow-up block below adds the attribute to anchors seeded
-- before this was added.
-- ============================================================

update ch_code_email_templates set
  body_html = replace(body_html,
    'Verify at gov.uk using GOV.UK One Login',
    'Verify at <a href="https://www.gov.uk/guidance/verify-your-identity-for-companies-house" target="_blank" rel="noopener noreferrer" style="color:#1155cc;">gov.uk using GOV.UK One Login</a>'),
  updated_at = now()
where key = 'offer';

update ch_code_email_templates set
  body_html = replace(body_html,
    'verify yourself at gov.uk',
    'verify yourself at <a href="https://www.gov.uk/guidance/verify-your-identity-for-companies-house" target="_blank" rel="noopener noreferrer" style="color:#1155cc;">gov.uk</a>'),
  updated_at = now()
where key = 'reminder';

update ch_code_email_templates set
  body_html = replace(body_html,
    'you can do it at gov.uk using GOV.UK One Login',
    'you can do it at <a href="https://www.gov.uk/guidance/verify-your-identity-for-companies-house" target="_blank" rel="noopener noreferrer" style="color:#1155cc;">gov.uk using GOV.UK One Login</a>'),
  updated_at = now()
where key = 'self_verify';

-- Retro-fit target/rel onto anchors seeded by the earlier form of this migration.
update ch_code_email_templates set
  body_html = replace(body_html,
    '<a href="https://www.gov.uk/guidance/verify-your-identity-for-companies-house" style="color:#1155cc;">',
    '<a href="https://www.gov.uk/guidance/verify-your-identity-for-companies-house" target="_blank" rel="noopener noreferrer" style="color:#1155cc;">'),
  updated_at = now()
where key in ('offer','reminder','self_verify');
