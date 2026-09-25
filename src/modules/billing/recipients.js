// Who a fee email goes to, and what to call them. Shared by the Push
// uplifts page and the single-client reprice modal.

// QBO routinely packs multiple emails into one PrimaryEmailAddr string,
// and BM's primary email may differ from the company billing address —
// split any comma/semicolon list into individual addresses.
export function splitEmails(s) {
  if (!s) return [];
  return String(s)
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter((x) => /.+@.+\..+/.test(x));
}

// Pick the primary contact for an entity. Falls back to any linked
// person if no row is flagged is_primary_contact (small entities
// often have a single person attached without the flag set).
export function resolvePrimaryContact(entity) {
  const links = entity?.entity_people || [];
  if (links.length === 0) return null;
  const primary = links.find((l) => l.is_primary_contact) || links[0];
  return primary?.person || null;
}

// Greeting name preference: preferred_name (BM "Preferred Name") wins
// over first_name; falls back to the first word of `name` so legacy
// people rows pre-dating the column split still render sensibly.
export function firstNameOf(person) {
  if (!person) return null;
  if (person.preferred_name) return person.preferred_name.trim();
  if (person.first_name) return person.first_name.trim();
  if (person.name) return person.name.trim().split(/\s+/)[0] || null;
  return null;
}

// Candidate "To" addresses in priority order, deduped:
//   1. QBO PrimaryEmailAddr (often the one Intuit invoices go to)
//   2. entity.billing_email (manual billing override)
//   3. BM primary contact's personal email
export function candidateAddresses(entity, contact) {
  const out = [];
  const seen = new Set();
  const push = (addr, label) => {
    const a = (addr || '').trim();
    if (!a || seen.has(a.toLowerCase())) return;
    seen.add(a.toLowerCase());
    out.push({ addr: a, label });
  };
  for (const m of entity?.qbo_customer_mappings || []) {
    if (m.role === 'not_a_client') continue;
    for (const a of splitEmails(m.qbo_email)) push(a, 'QBO email');
  }
  for (const a of splitEmails(entity?.billing_email)) push(a, 'Billing email');
  for (const a of splitEmails(contact?.email)) push(a, 'Primary contact');
  return out;
}
