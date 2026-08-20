// BrightManager Clients export → normalised per-row payload for the
// import_bm_clients RPC. Column names verified against a 625-row export
// (All Clients, 2026-04-15).

import { parseCsv } from '../parseCsv';

const CLIENT_TYPE_MAP = {
  'Private Limited Company': 'limited_company',
  'Limited Liability Partnership': 'partnership',
  'Partnership': 'partnership',
  'Self Assessment': 'sole_trader',
};

function normUtr(v) {
  if (!v) return null;
  const stripped = String(v).replace(/\D/g, '');
  return stripped || null;
}

function normCompanyNumber(v) {
  if (!v) return null;
  const t = String(v).trim().toUpperCase().replace(/\s+/g, '');
  return t || null;
}

function normEmail(v) {
  if (!v) return null;
  const t = String(v).trim().toLowerCase();
  return t || null;
}

function normText(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t || null;
}

function normNI(v) {
  if (!v) return null;
  const t = String(v).replace(/\s+/g, '').toUpperCase();
  return t || null;
}

// ── Agent-authorisation columns ──────────────────────────────────────────
// BrightManager records, per tax, whether we are the authorised agent. The
// exact header wording isn't known here — it varies by BM version and by which
// columns the exporter ticked — so rather than guess one spelling, a header
// qualifies when it names an authorisation AND names a tax. Whatever matched is
// reported back so the dry-run preview shows exactly which columns were read
// (and, more usefully, that none were).
//
// Feeds entities.bm_agent_* via import_bm_agent_flags, which drives the BM leg
// of Onboarding → Cross-check. A tax whose column is absent stays null, meaning
// "BM never told us", never "not authorised".
const AGENT_WORD = /(agent|authoris|authoriz|64-?8|\bauth\b)/i;
const AGENT_TAXES = [
  { key: 'cis', re: /\bcis\b|construction industry/i },
  { key: 'vat', re: /\bvat\b|value added/i },
  { key: 'paye', re: /\bpaye\b|employer|payroll/i },
  { key: 'ct', re: /corporation tax|\bct\b|company tax/i },
  { key: 'sa', re: /self.?assessment|\bsa\b|personal tax|income tax/i },
];

// Yes / No / Y / 1 / "Authorised" / a date (authorised on…) → boolean.
// Anything unrecognised stays null rather than guessing a direction.
function parseAgentFlag(raw) {
  const v = raw == null ? '' : String(raw).trim();
  if (!v) return null;
  if (/^(y|yes|true|1|authorised|authorized|active|agent|approved)/i.test(v)) return true;
  if (/^(n|no|false|0|not|none|unauthorised|unauthorized|pending|awaiting)/i.test(v)) return false;
  // BM sometimes stores the date authorisation came through instead of a flag.
  const asDate = new Date(v);
  if (!Number.isNaN(asDate.getTime()) && /\d{4}|\d{1,2}[/-]\d{1,2}/.test(v)) return true;
  return null;
}

// The engagement-letter date. Anchor Gas Services showed the problem: BM holds
// a signed date while Athena's checklist step still reads pending, so the
// client was flagged for a letter that exists. Matched on wording, like the
// agent columns.
const LOE_HEADER = /(letter of engagement|engagement letter|\bloe\b)/i;

export function detectLoeColumn(header) {
  const i = header.findIndex((h) => h && LOE_HEADER.test(h));
  return i < 0 ? null : { header: header[i], index: i };
}

// BM writes these as dates; anything unparseable is left null rather than
// guessed at.
function parseLoeDate(raw) {
  const v = raw == null ? '' : String(raw).trim();
  if (!v) return null;
  // dd/mm/yyyy — the format BM exports, and the one Date() reads as US
  const uk = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (uk) {
    const [, d, m, y] = uk;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const iso = new Date(v);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString().slice(0, 10);
}

// Find the agent columns in a header row. Returns [{ tax, header, index }].
function detectAgentColumns(header) {
  const found = [];
  header.forEach((h, i) => {
    if (!h || !AGENT_WORD.test(h)) return;
    const tax = AGENT_TAXES.find((t) => t.re.test(h));
    // First column wins per tax — BM exports occasionally carry both a flag
    // and a date column for the same tax, and the flag is listed first.
    if (tax && !found.some((f) => f.tax === tax.key)) {
      found.push({ tax: tax.key, header: h, index: i });
    }
  });
  return found;
}

// Parse raw CSV text → structured per-row objects. No DB calls.
// Returns { rows, warnings, skipped, headerOk }
export function parseBmClientsCsv(text) {
  const raw = parseCsv(text);
  if (raw.length < 2) {
    return { rows: [], warnings: [], skipped: [], headerOk: false };
  }
  const header = raw[0].map((h) => h.replace(/^\uFEFF/, '').trim());
  const idxOf = (name) => header.indexOf(name);

  // Required columns check
  const required = ['Client', 'Client Type', 'Internal Reference'];
  const missing = required.filter((c) => idxOf(c) < 0);
  if (missing.length) {
    return {
      rows: [], warnings: [], skipped: [],
      headerOk: false,
      headerError: `Missing required columns: ${missing.join(', ')}`,
    };
  }

  const get = (row, name) => {
    const i = idxOf(name);
    return i < 0 ? null : normText(row[i]);
  };

  // CH personal (identity-verification) code — added to the BM export later.
  // Matched case-insensitively against a few likely header spellings so the
  // Stage-5 reconciliation lights up automatically once the column appears.
  const CODE_HEADERS = [
    'CH Personal Code', 'Companies House Personal Code', 'Personal Code',
    'CH Identity Code', 'Identity Verification Code', 'ID Verification Code',
  ].map((h) => h.toLowerCase());
  const codeIdx = header.findIndex((h) => CODE_HEADERS.includes(h.toLowerCase()));

  // Agent-authorisation columns, if this export carries them.
  const agentCols = detectAgentColumns(header);
  const loeCol = detectLoeColumn(header);

  const rows = [];
  const warnings = [];
  const skipped = [];

  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    if (row.length !== header.length) continue; // malformed
    if (!row[0]) continue; // blank line

    const name = get(row, 'Client');
    const rawType = get(row, 'Client Type');
    const bmId = get(row, 'Internal Reference');
    const type = rawType ? CLIENT_TYPE_MAP[rawType] || null : null;

    if (!name) {
      skipped.push({ row: i + 1, bm_client_id: bmId, name: null, field: 'name', reason: 'missing Client name' });
      continue;
    }
    if (!bmId) {
      skipped.push({ row: i + 1, bm_client_id: null, name, field: 'bm_client_id', reason: 'missing Internal Reference — cannot link across systems' });
      continue;
    }
    if (!type) {
      skipped.push({ row: i + 1, bm_client_id: bmId, name, field: 'type', reason: `unmapped Client Type "${rawType}"` });
      continue;
    }

    // UTR resolution — company UTR for LTD/LLP, Partnership UTR for partnerships
    let utr = null;
    if (type === 'limited_company') {
      utr = normUtr(get(row, 'Company UTR'));
    } else if (type === 'partnership') {
      utr = normUtr(get(row, 'Partnership/Trust UTR')) || normUtr(get(row, 'Company UTR'));
    } else {
      utr = normUtr(get(row, 'Personal UTR Number'));
    }

    if (utr && utr.length !== 10) {
      warnings.push({ row: i + 1, bm_client_id: bmId, name, field: 'utr', message: `UTR "${utr}" is ${utr.length} digits (expected 10)` });
    }

    const companyNumber = normCompanyNumber(get(row, 'Company Number'));
    if (type === 'limited_company' && !companyNumber) {
      warnings.push({ row: i + 1, bm_client_id: bmId, name, field: 'company_number', message: 'limited company without Company Number' });
    }

    const primaryEmail = normEmail(get(row, 'Email'));
    if (!primaryEmail) {
      warnings.push({ row: i + 1, bm_client_id: bmId, name, field: 'email', message: 'no primary email — client portal user cannot be invited later' });
    }

    rows.push({
      _source_row: i + 1,
      bm_client_id: bmId,
      name,
      type,
      company_number: companyNumber,
      utr,
      vat_number: normText(get(row, 'VAT Number'))?.replace(/\s+/g, '') || null,
      paye_ref: normText(get(row, 'PAYE Employers Reference')),
      accounts_office_ref: normText(get(row, 'PAYE Accounts Office Reference')),
      ch_auth_code: normText(get(row, 'Companies House Authentication Code')),
      manager: normText(get(row, 'Manager')),
      grade: normText(get(row, 'Client Grade')),
      // Reviewer roles in BM's "Monitor" columns. These go into
      // service_reviewers via import_bm_reviewers — not entities.
      vat_reviewer_name: normText(get(row, 'VAT Filer (Monitor)')),
      accounts_reviewer_name: normText(get(row, 'Companies House Accounts Filer (Monitor)')),
      // Primary person info — persisted via import_bm_clients (mig 073)
      // into people + entity_people as the entity's primary contact.
      _primary_email: primaryEmail,
      _primary_first_name: normText(get(row, 'First Name')),
      _primary_last_name: normText(get(row, 'Last Name')),
      _primary_preferred_name: normText(get(row, 'Preferred Name')),
      _primary_name: [get(row, 'First Name'), get(row, 'Last Name')].filter(Boolean).join(' ') || null,
      _primary_phone: normText(get(row, 'Mobile Number')),
      _primary_ni: normNI(get(row, 'NI Number')),
      _primary_ch_personal_code: codeIdx >= 0 ? normText(row[codeIdx]) : null,
      // Only taxes whose column exists get a key — see import_bm_agent_flags.
      _agent_flags: agentCols.length
        ? Object.fromEntries(agentCols.map((c) => [`bm_agent_${c.tax}`, parseAgentFlag(row[c.index])]))
        : null,
      _loe_signed_date: loeCol ? parseLoeDate(row[loeCol.index]) : undefined,
    });
  }

  // Duplicate bm_client_id scan: same Internal Reference, different names.
  // entities upserts on bm_client_id so only one row survives — the other
  // client's tasks silently attach to the wrong entity. Flag in dry-run.
  const refToNames = new Map();
  const refFirstRow = new Map();
  for (const r of rows) {
    if (!r.bm_client_id || !r.name) continue;
    if (!refToNames.has(r.bm_client_id)) {
      refToNames.set(r.bm_client_id, new Set());
      refFirstRow.set(r.bm_client_id, r._source_row || null);
    }
    refToNames.get(r.bm_client_id).add(r.name);
  }
  for (const [ref, nameSet] of refToNames) {
    if (nameSet.size > 1) {
      const names = Array.from(nameSet).sort();
      warnings.push({
        row: refFirstRow.get(ref),
        bm_client_id: ref,
        name: null,
        field: 'bm_client_id',
        message: `Duplicate Internal Reference "${ref}" used by ${nameSet.size} different clients (${names.join(' / ')}) — only one will survive the upsert. Rename one in BrightManager before approving.`,
      });
    }
  }

  return {
    rows, warnings, skipped, headerOk: true,
    // Shown in the dry-run preview: which agent columns were found, so an
    // export without them is visibly a no-op rather than a silent one.
    agentColumns: agentCols.map((c) => ({ tax: c.tax, header: c.header })),
    loeColumn: loeCol ? loeCol.header : null,
  };
}
