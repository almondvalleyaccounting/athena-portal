// BrightManager Clients export → normalised per-row payload for the
// import_bm_clients RPC. Column names verified against a 625-row export
// (All Clients, 2026-04-15).

import { parseCsv } from '../parseCsv';

// BrightManager distinguishes an LLP from an ordinary partnership and Athena
// used to throw that away, mapping both to 'partnership'. An LLP is registered
// at Companies House — accounts, a confirmation statement, an authentication
// code, members not directors — while an ordinary partnership is not registered
// at all. Collapsing them meant the Companies House refresh (which targets
// registered bodies) never once fetched Ready Rentals LLP: no company status,
// no confirmation statement date, so it could not appear on the CS list.
// The distinction arrives on every import; keep it.
const CLIENT_TYPE_MAP = {
  'Private Limited Company': 'limited_company',
  'Limited Liability Partnership': 'llp',
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

// ── Person references ────────────────────────────────────────────────────
// BM's export carries two reference fields and they are not the same kind of
// thing:
//
//   "Internal Reference"        -> the CLIENT  -> entities.bm_client_id
//   "Person Internal Reference" -> the PERSON  -> people.bm_person_ref
//
// They share a namespace — 320 of the 344 person references in the 15/04/2026
// export are byte-identical to some client's Internal Reference, because BM
// codes an SA client after the person it belongs to. So they are read into
// separate fields and never compared. Nothing in this file falls back to
// matching one against the other.
//
// The person reference is also NOT unique per person: BETTD01 is both Denise
// and Stephen Bett, SHAWW01 is both James and William Shaw. Identity is
// (reference, date of birth) — see sql/255_bm_person_reference.sql. The scan
// at the bottom of this file reports any reference carrying two names so a
// new one shows up in the dry run rather than inside a merge.

// dd/mm/yyyy (BM's UI export) and yyyy-mm-dd (BM's CSV export) both appear.
// Anything else is left null — a wrong DOB is worse than no DOB, because DOB
// is what separates two people who share a reference.
function normDob(v) {
  if (!v) return null;
  const t = String(v).trim();
  if (!t) return null;
  let y; let m; let d;
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  const uk = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (iso) { [, y, m, d] = iso; } else if (uk) { [, d, m, y] = uk; } else { return null; }
  const yr = Number(y); const mo = Number(m); const dy = Number(d);
  if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
  // A DOB outside living memory is a parse error, not a birthday.
  if (yr < 1900 || yr > new Date().getFullYear()) return null;
  return `${yr}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
}

// BM's "Mobile Number" column is free text and occasionally holds prose —
// "As above" and "." are both in the 15/04/2026 export. Anything without a
// plausible number of digits is rejected rather than stored: the Communications
// SMS matcher keys on the last 9 digits, so a junk value is not merely useless,
// it can collide. UK mobiles are normalised to E.164 because that is what
// sending an SMS wants; the digits are preserved either way, so a number stored
// as +447810553033 still matches a Google contact stored as "07810 553033".
function normPhone(v) {
  if (!v) return null;
  const raw = String(v).trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return null;
  if (/^07\d{9}$/.test(digits)) return `+44${digits.slice(1)}`;
  if (/^447\d{9}$/.test(digits)) return `+${digits}`;
  return raw.replace(/\s+/g, ' ');
}

// Surname + first name, normalised. Mirrors _bm_name_key() in
// sql/255_bm_person_reference.sql — keep the two in step. Handles BM's two
// name shapes ("Hunter, Gordon" and "Gordon Alexander Hunter" are one key)
// without collapsing Sarah and Simon Collister, who share a surname, an
// initial and a BM reference.
function nameKey(name) {
  const raw = String(name || '').toLowerCase().replace(/[^a-z, ]/g, '');
  const commaForm = raw.includes(',');
  const t = raw.replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!t.length) return null;
  if (t.length === 1) return t[0];
  return commaForm ? `${t[0]} ${t[1]}` : `${t[t.length - 1]} ${t[0]}`;
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

// Read one of the two person blocks BM puts on every client row. The
// secondary block (columns 48-65) was dropped entirely until now, which is
// why 57 people BM knows about had no record in Athena — including David
// Boyd senior, who is only ever the SECONDARY contact on the two Monument
// companies while his son holds the primary slot.
//
// `slot` is 'primary' or 'secondary'; the secondary headers are the primary
// ones with a "Secondary " prefix, all the way through.
function readPersonBlock(get, row, slot) {
  const p = slot === 'secondary' ? 'Secondary ' : '';
  const ref = normText(get(row, `${p}Person Internal Reference`));
  const first = normText(get(row, `${p}First Name`));
  const last = normText(get(row, `${p}Last Name`));
  const preferred = normText(get(row, `${p}Preferred Name`));
  const full = [first, last].filter(Boolean).join(' ') || null;

  // No reference, or nothing to call them by — nothing to identify.
  if (!ref || (!full && !preferred)) return null;

  return {
    slot,
    person_ref: ref,
    first_name: first,
    last_name: last,
    preferred_name: preferred,
    name: full,
    email: normEmail(get(row, `${p}Email`)),
    phone: normPhone(get(row, `${p}Mobile Number`)),
    ni_number: normNI(get(row, `${p}NI Number`)),
    dob: normDob(get(row, `${p}Date of Birth`)),
    ch_personal_code: normText(get(row, `${p}Companies House Personal Code`)),
  };
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

    // UTR resolution. An LLP resolves exactly as a partnership does — it is
    // transparent for tax and files an SA800 under a partnership UTR, and this
    // is the branch it has always taken, so splitting the type changes no
    // client's UTR. (The old comment here claimed LLPs took the company UTR;
    // they never did. Corrected rather than implemented — changing which BM
    // column a tax reference comes from is not a change to make on a guess.)
    let utr = null;
    if (type === 'limited_company') {
      utr = normUtr(get(row, 'Company UTR'));
    } else if (type === 'partnership' || type === 'llp') {
      utr = normUtr(get(row, 'Partnership/Trust UTR')) || normUtr(get(row, 'Company UTR'));
    } else {
      utr = normUtr(get(row, 'Personal UTR Number'));
    }

    if (utr && utr.length !== 10) {
      warnings.push({ row: i + 1, bm_client_id: bmId, name, field: 'utr', message: `UTR "${utr}" is ${utr.length} digits (expected 10)` });
    }

    const companyNumber = normCompanyNumber(get(row, 'Company Number'));
    // An LLP is registered too, so a missing number is the same data error.
    if ((type === 'limited_company' || type === 'llp') && !companyNumber) {
      warnings.push({ row: i + 1, bm_client_id: bmId, name, field: 'company_number', message: `${type === 'llp' ? 'LLP' : 'limited company'} without Company Number` });
    }

    // Both person blocks. The slot is a property of the LINK, not of the
    // person — 53 of BM's 344 references are primary on one client and
    // secondary on another — so it travels with the row, not with the name.
    const people = [
      readPersonBlock(get, row, 'primary'),
      readPersonBlock(get, row, 'secondary'),
    ].filter(Boolean);

    // The fuzzy code column, when the export spells the header differently.
    if (people[0] && !people[0].ch_personal_code && codeIdx >= 0) {
      people[0].ch_personal_code = normText(row[codeIdx]);
    }

    if (!people.length) {
      warnings.push({
        row: i + 1, bm_client_id: bmId, name, field: 'person_ref',
        message: 'no Person Internal Reference on this row — the contact cannot be identified across clients, so a duplicate person will be created for this client alone',
      });
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
      _primary_phone: normPhone(get(row, 'Mobile Number')),
      _primary_ni: normNI(get(row, 'NI Number')),
      _primary_ch_personal_code: codeIdx >= 0 ? normText(row[codeIdx]) : null,
      // Both person blocks, keyed by BM's Person Internal Reference. Consumed
      // by import_bm_people, which keys people on (reference, DOB) instead of
      // on "the contact of this entity". Kept separate from bm_client_id
      // above — the two references share a namespace and must never be
      // compared. See the note at the top of this file.
      _people: people,
      _primary_person_ref: people.find((p) => p.slot === 'primary')?.person_ref || null,
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

  // Person-reference collision scan: one Person Internal Reference carrying
  // two different people. BM does this for family members — it issues a
  // second reference sometimes (BOYDD01 / BOYDD02, a father and son both
  // called David Boyd) and not others. In the 15/04/2026 export four
  // references collide, and each differs on name, DOB and NI at once:
  //
  //   BETTD01  Denise Bett b.1981-01-05 / Stephen Bett b.1965-08-04
  //   BLACR01  Ronald Blacklaws b.1954-06-26 / James Blacklaw b.1978-11-10
  //   COLLS02  Sarah Collister b.1982-07-29 / Simon Collister b.1980-03-29
  //   SHAWW01  James Shaw b.1994-06-18 / William Shaw b.1960-06-15
  //
  // Identity is (reference, DOB) so these import as separate people
  // correctly, but the reference is still wrong in BM and will keep colliding
  // on every re-import until someone fixes it there. Reported so it lands on
  // Sophie's list rather than being absorbed silently.
  const refSeen = new Map();
  for (const r of rows) {
    for (const p of r._people || []) {
      if (!refSeen.has(p.person_ref)) refSeen.set(p.person_ref, new Map());
      const byKey = refSeen.get(p.person_ref);
      const key = nameKey(p.name || p.preferred_name);
      if (!key) continue;
      if (!byKey.has(key)) {
        byKey.set(key, { name: p.name || p.preferred_name, dob: p.dob, ni: p.ni_number, row: r._source_row });
      }
    }
  }
  const personRefCollisions = [];
  for (const [ref, byKey] of refSeen) {
    if (byKey.size < 2) continue;
    const seen = Array.from(byKey.values());
    personRefCollisions.push({ person_ref: ref, people: seen });
    warnings.push({
      row: seen[0].row,
      bm_client_id: null,
      name: null,
      field: 'person_ref',
      message: `Person Internal Reference "${ref}" is shared by ${seen.length} different people (${seen.map((s) => `${s.name}${s.dob ? ` b.${s.dob}` : ''}`).join(' / ')}). They import as separate people because their dates of birth differ, but the reference is wrong in BrightManager — give each of them their own, the way BM already does for the two David Boyds.`,
    });
  }

  return {
    rows, warnings, skipped, headerOk: true,
    // Shown in the dry-run preview: which agent columns were found, so an
    // export without them is visibly a no-op rather than a silent one.
    agentColumns: agentCols.map((c) => ({ tax: c.tax, header: c.header })),
    loeColumn: loeCol ? loeCol.header : null,
    // One reference, two people — a BM data fix, not an Athena one.
    personRefCollisions,
    // Dry-run counters: how many people this upload actually describes, as
    // against how many client rows it has.
    personSummary: (() => {
      const refs = new Set();
      const ids = new Set();
      let secondary = 0;
      let missing = 0;
      for (const r of rows) {
        if (!(r._people || []).length) missing += 1;
        for (const p of r._people || []) {
          refs.add(p.person_ref);
          ids.add(`${p.person_ref}|${p.dob || nameKey(p.name || p.preferred_name) || ''}`);
          if (p.slot === 'secondary') secondary += 1;
        }
      }
      return {
        distinct_refs: refs.size,
        distinct_people: ids.size,
        secondary_contacts: secondary,
        rows_without_a_person_ref: missing,
      };
    })(),
  };
}
