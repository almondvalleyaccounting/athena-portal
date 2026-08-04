/*
  Owner-cost suggestions — reads the client's QBO nominal hierarchy and flags the
  codes that look like director personal items rather than costs of trading.

  The point of the Underlying Performance tab is "what does this business earn
  for its owner", so anything that is really the owner taking money out — or a
  tax-planning claim rather than a real running cost — has to come back out of
  the reported figure. Those codes are named fairly predictably in a UK owner-
  managed file ("Dividends", "Directors remuneration", "Use of home as office"),
  so we can propose them instead of making someone hunt the chart of accounts.

  Nothing here changes a number on its own. Every suggestion is a proposal with
  a tick box; the maths only moves once a human confirms it. High-confidence
  rules arrive pre-ticked (one click to accept), the softer ones don't.

  Matching runs over the fully-qualified name, so a sub-account inherits its
  parent's meaning — "Directors remuneration:Salary" is caught by the parent.
*/

// Ordered most- to least-certain. Each rule explains itself in the UI so the
// person ticking knows why it was raised, rather than trusting a black box.
export const OWNER_COST_RULES = [
  {
    key: 'dividends',
    label: 'Dividends',
    why: 'A distribution of profit to the owner, not a cost of running the business.',
    confidence: 'high',
    test: (t) => /\bdividend/.test(t),
  },
  {
    key: 'director_pay',
    label: "Director's pay",
    why: "The owner's own remuneration — set by tax planning, not by what the role costs to fill.",
    confidence: 'high',
    // "Director" alone isn't enough (D&O insurance is a real cost), so it has to
    // pair with a remuneration word.
    test: (t) => /\bdirector/.test(t)
      && /(salar|wage|remuner|emolument|\bpay\b|\bfees?\b|\bni\b|\bnic\b|national insurance|pension|bonus|drawing)/.test(t),
  },
  {
    key: 'home_office',
    label: 'Home office',
    why: 'A use-of-home claim against the owner rather than a running cost the business actually incurs.',
    confidence: 'high',
    test: (t) => /home\s*(as\s*(an?\s*)?)?office|office\s*at\s*home|use\s*of\s*(the\s*)?home|working\s*from\s*home|home\s*working/.test(t),
  },
  {
    key: 'drawings',
    label: 'Drawings',
    why: 'Money taken out by the owner or proprietor — worth checking whether it belongs in the P&L at all.',
    confidence: 'medium',
    test: (t) => /\bdrawings?\b|\bproprietor/.test(t),
  },
  {
    key: 'personal',
    label: 'Personal expenses',
    why: "Named as personal, so it's the owner's spending sitting in the business.",
    confidence: 'medium',
    test: (t) => /\bpersonal\b|\bprivate use\b/.test(t),
  },
  {
    key: 'family_pay',
    label: 'Family wages',
    why: 'Pay to a spouse or family member is usually part of the owner package rather than a market-rate hire.',
    confidence: 'medium',
    test: (t) => /\b(spouse|wife|husband|family)\b/.test(t) && /(salar|wage|\bpay\b|remuner)/.test(t),
  },
];

const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

// First matching rule wins — rules are ordered by how sure we are.
export const ruleFor = (account) => {
  const text = norm(`${account?.fq_name || account?.name || ''} ${account?.parent_name || ''} ${account?.sub_type || ''}`);
  if (!text) return null;
  return OWNER_COST_RULES.find((r) => r.test(text)) || null;
};

/*
  Build the suggestion list for one client.

  accounts     — the QBO chart of accounts (P&L codes) from the `accounts` metric
  taggedIds    — account ids already confirmed as owner costs (skip: done)
  dismissedIds — account ids a human has already rejected (skip: asked and answered)
  amountFor    — (accountId) => { amount, income } for the selected period, so the
                 suggestion can show what accepting it would actually move
*/
export function suggestOwnerCosts(accounts, { taggedIds, dismissedIds, amountFor } = {}) {
  // The P&L report only gives amounts on leaf rows — a parent with sub-accounts
  // appears as a section summary, which the detail pull skips. So a tagged
  // parent would add back nothing while looking tagged. Suggest its children
  // instead; they match anyway because the rules read the qualified name.
  const hasChildren = new Set((accounts || []).map((a) => a.parent_id).filter(Boolean));

  const out = [];
  for (const a of accounts || []) {
    if (taggedIds?.has(a.id) || dismissedIds?.has(a.id)) continue;
    if (hasChildren.has(a.id)) continue;
    const rule = ruleFor(a);
    if (!rule) continue;

    const { amount = 0, income = false } = amountFor ? (amountFor(a.id) || {}) : {};
    // An archived code with nothing posted in the period is just noise.
    if (a.active === false && !amount) continue;

    out.push({
      account_id: a.id,
      acct_num: a.acct_num || null,
      account_name: a.name || '',
      rule_key: rule.key,
      rule_label: rule.label,
      why: rule.why,
      confidence: rule.confidence,
      amount,
      income,
      // Income coded to a "dividends" name is dividends *received* — a different
      // decision (strip investment income) that deserves a deliberate tick.
      preTick: rule.confidence === 'high' && !income,
    });
  }

  const rank = (s) => (s.confidence === 'high' ? 0 : 1);
  return out.sort((x, y) =>
    rank(x) - rank(y)
    || Math.abs(y.amount) - Math.abs(x.amount)
    || String(x.acct_num || '').localeCompare(String(y.acct_num || ''), undefined, { numeric: true })
    || x.account_name.localeCompare(y.account_name));
}
