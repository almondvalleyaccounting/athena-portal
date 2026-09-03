import { supabase } from './supabase';

// Where a quote email is addressed to.
//
// The Send Quote box used to open empty every time, so the same address was
// retyped for every re-send — even though we already hold it in at least three
// places. This resolves it, in order of how much the source proves:
//
//   1. the recipients of the last send of this quote (a re-send goes back to
//      whoever it went to — that address is proven, it arrived once already)
//   2. the address the quote was accepted from
//   3. the entity's billing / prospect email
//   4. the entity's primary contact
//   5. any current director or contact we hold an email for
//
// The first tier that yields anything wins; tiers are not merged, so a stale
// director address can never quietly ride along with the address a partner
// actually used. Everything is a prefill into an editable box, and the modal
// says which tier it came from, so a wrong guess is visible before send.

const SOURCE_LABELS = {
  last_send: 'last send',
  accepted: 'the acceptance',
  entity_email: 'the client record',
  primary_contact: 'the primary contact',
  contact: 'the client contacts',
};

export const recipientSourceLabel = (source) => SOURCE_LABELS[source] || null;

const clean = (raw) => {
  const seen = new Set();
  const out = [];
  for (const part of (Array.isArray(raw) ? raw : [raw])) {
    if (typeof part !== 'string') continue;
    for (const piece of part.split(/[,;]/)) {
      const email = piece.trim();
      if (!email || !email.includes('@')) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(email);
    }
  }
  return out;
};

const empty = { to: [], cc: [], source: null, sourceLabel: null, sentAt: null };

// The last time this quote (or group) actually went out, and to whom.
const lastSend = async ({ quoteId, groupId }) => {
  const q = groupId
    ? supabase.from('audit_log').select('detail, created_at')
        .eq('entity_type', 'billing_group').eq('entity_id', groupId).eq('action', 'sent_to_client_group')
    : supabase.from('audit_log').select('detail, created_at')
        .eq('entity_type', 'quote').eq('entity_id', quoteId).eq('action', 'sent_to_client');
  const { data } = await q.order('created_at', { ascending: false }).limit(1);
  const row = data?.[0];
  if (!row) return null;
  // Older sends predate the recipients array and carry a single `recipient`.
  const to = clean(row.detail?.recipients || row.detail?.recipient);
  if (!to.length) return null;
  return { to, cc: clean(row.detail?.cc), sentAt: row.created_at };
};

// A quote raised before the entity link existed carries only the client's name,
// so fall back to matching it — ilike with no wildcard is an exact, case-
// insensitive match, which is as loose as this is allowed to get.
const resolveEntityIds = async (quote, entityIds) => {
  const ids = (entityIds || []).filter(Boolean);
  if (ids.length) return [...new Set(ids)];
  if (quote?.entity_id) return [quote.entity_id];
  const name = (quote?.relationship_group || '').trim();
  if (!name) return [];
  const { data } = await supabase.from('entities').select('id').ilike('name', name).limit(2);
  // Two entities of the same name is an ambiguity we should not guess at.
  return data?.length === 1 ? [data[0].id] : [];
};

export async function resolveQuoteRecipients(quote, { groupId = null, entityIds = null } = {}) {
  if (!quote) return empty;

  try {
    const sent = await lastSend({ quoteId: quote.id, groupId });
    if (sent) {
      return { ...sent, source: 'last_send', sourceLabel: SOURCE_LABELS.last_send };
    }

    const accepted = clean(quote.accepted_client_email);
    if (accepted.length) {
      return { ...empty, to: accepted, source: 'accepted', sourceLabel: SOURCE_LABELS.accepted };
    }

    const ids = await resolveEntityIds(quote, entityIds);
    if (!ids.length) return empty;

    const [{ data: ents }, { data: links }] = await Promise.all([
      supabase.from('entities').select('id, billing_email, prospect_email').in('id', ids),
      supabase.from('entity_people')
        .select('entity_id, role, is_primary_contact, ended_on, person:people(email)')
        .in('entity_id', ids).is('ended_on', null),
    ]);

    const entityEmails = clean((ents || []).flatMap(e => [e.billing_email, e.prospect_email]));
    if (entityEmails.length) {
      return { ...empty, to: entityEmails, source: 'entity_email', sourceLabel: SOURCE_LABELS.entity_email };
    }

    const withEmail = (links || []).filter(l => l.person?.email);
    const primary = clean(withEmail.filter(l => l.is_primary_contact).map(l => l.person.email));
    if (primary.length) {
      return { ...empty, to: primary, source: 'primary_contact', sourceLabel: SOURCE_LABELS.primary_contact };
    }

    const contacts = clean(
      withEmail.filter(l => ['director', 'contact', 'partner', 'sole_trader', 'member'].includes(l.role))
        .map(l => l.person.email)
    );
    if (contacts.length) {
      return { ...empty, to: contacts, source: 'contact', sourceLabel: SOURCE_LABELS.contact };
    }

    return empty;
  } catch {
    // A prefill that fails is an empty box, which is where this started —
    // never a modal that will not open.
    return empty;
  }
}
