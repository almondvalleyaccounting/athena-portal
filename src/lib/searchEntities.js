import { supabase } from './supabase';

// Find clients by name, company number, UTR, VAT, PAYE, BrightManager id
// or email. One definition, shared by the header QuickSearch and the
// client picker on New Quote, so both find a client the same way.
//
// Returns [{ id, name, type, company_number, entity_status, matched }],
// where `matched` says which identifier hit when it wasn't the name.
export async function searchEntities(raw, { limit = 8 } = {}) {
  // Commas and brackets would break the PostgREST or() filter.
  const q = (raw || '').replace(/[,()*]/g, ' ').trim();
  if (q.length < 2) return [];
  // Identifiers are stored without spaces; people type "38890 25012" or
  // "GB 488 0176 63". Match those on a compacted copy.
  const compact = q.replace(/\s+/g, '');
  const vat = compact.replace(/^GB/i, '');
  const idFilters = compact.length >= 3
    ? [`company_number.ilike.%${compact}%`, `utr.ilike.%${compact}%`, `vat_number.ilike.%${vat}%`,
       `paye_ref.ilike.%${compact}%`, `bm_client_id.ilike.%${compact}%`,
       `billing_email.ilike.%${compact}%`, `prospect_email.ilike.%${compact}%`]
    : [];
  const [{ data: rows }, { data: emailRows }, { data: qboRows }] = await Promise.all([
    supabase.from('entities')
      .select('id, name, type, company_number, entity_status, utr, vat_number, paye_ref, bm_client_id, billing_email, prospect_email')
      .or([`name.ilike.%${q}%`, ...idFilters].join(','))
      .order('name').limit(limit),
    // BrightManager contact emails aren't on entities.
    compact.length >= 3
      ? supabase.from('v_email_reconciliation').select('entity_id, name, bm_contact_email')
          .ilike('bm_contact_email', `%${compact}%`).limit(5)
      : Promise.resolve({ data: [] }),
    // Nor are QuickBooks billing emails — they sit on the customer mapping
    // (one text field, sometimes several addresses separated by , or ;).
    compact.length >= 3
      ? supabase.from('qbo_customer_mappings').select('entity_id, qbo_email, entity:entities(name)')
          .not('entity_id', 'is', null).ilike('qbo_email', `%${compact}%`).limit(5)
      : Promise.resolve({ data: [] }),
  ]);
  const out = (rows || []).map((c) => ({ ...c, matched: matchedOn(c, q, compact, vat) }));
  for (const e of emailRows || []) {
    if (!out.some((c) => c.id === e.entity_id)) {
      out.push({ id: e.entity_id, name: e.name, matched: `Email ${e.bm_contact_email}` });
    }
  }
  for (const m of qboRows || []) {
    if (!out.some((c) => c.id === m.entity_id)) {
      const hit = String(m.qbo_email || '').split(/[,;]+/).map((x) => x.trim())
        .find((x) => x.toLowerCase().includes(compact.toLowerCase())) || m.qbo_email;
      out.push({ id: m.entity_id, name: m.entity?.name || 'Client', matched: `QBO email ${hit}` });
    }
  }
  return out.slice(0, limit);
}

function matchedOn(c, q, compact, vat) {
  const has = (v, needle) => v && needle && String(v).toLowerCase().includes(needle.toLowerCase());
  if (has(c.name, q)) return null;
  if (has(c.company_number, compact)) return `Company no. ${c.company_number}`;
  if (has(c.utr, compact)) return `UTR ${c.utr}`;
  if (has(c.vat_number, vat)) return `VAT ${c.vat_number}`;
  if (has(c.paye_ref, compact)) return `PAYE ${c.paye_ref}`;
  if (has(c.bm_client_id, compact)) return `BrightManager ${c.bm_client_id}`;
  if (has(c.billing_email, compact)) return `Email ${c.billing_email}`;
  if (has(c.prospect_email, compact)) return `Email ${c.prospect_email}`;
  return null;
}
