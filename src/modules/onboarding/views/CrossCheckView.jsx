import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { BTN } from '../../../lib/buttonStyles';
import ViewTabs from '../components/ViewTabs';
import {
  listCrossCheck, listCrossCheckTaxes, getCrossCheckCoverage, listCrossCheckOrphans,
  listCrossCheckLinkConflicts, listDirectorSa, setPersonUtr,
  listCrossCheckOverrides, setCrossCheckOverride, clearCrossCheckOverride,
  listCrossCheckBillingMissing, TAX_LABELS, ONBOARDING_STATUSES,
} from '../api';

/*
  Cross-check — the sense check on the onboarding board.

  The whole page is one matrix: a row per client, a mark per check. Every ✕
  is one of three findings — Agent missing, Code missing, Billing missing — or
  Other (2026-10-10: the eight verdicts it replaced were too many to act on).
  Other marks: ✓ verified, ○ in progress, ~ unverifiable while the SA scrape
  is partial, ? no feed. Clicking a mark opens a modal with the evidence
  (per-tax comparison, directors' SA with inline UTR capture). There a person can
  override a mark they have looked into, with a comment (sql/367) — e.g. the
  payroll is billed through another company in the group. An override holds
  only while the check reads the same; if the issue changes, the mark returns.
  A client whose every flagged mark is overridden reads "Explained" and leaves
  "Needs a look". Only clients with something to look at show by default.

  The one thing this screen must never do is turn missing evidence into a
  finding: a leg with no feed reads ?, never ✕. See sql/243–253.
*/

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };

// ── The marks ──────────────────────────────────────────────────────────────
// One visual language for every cell. state → shape + colour; the title is
// where the words live.
const MARK = {
  ok:        { glyph: '✓', bg: tones.success.bg, fg: tones.success.fg, border: tones.success.border },
  bad:       { glyph: '✕', bg: tones.danger.bg,  fg: tones.danger.fg,  border: tones.danger.border },
  awaiting:  { glyph: '○', bg: tones.teal.bg,    fg: tones.teal.fg,    border: tones.teal.border },
  // Deliberately quiet: unverified means the scrape cannot prove anything
  // yet, and ~200 amber marks were drowning the real signal.
  unverified:{ glyph: '~', bg: '#fafaf9', fg: '#a8a29e', border: '#e7e5e4' },
  nodata:    { glyph: '?', bg: '#f8fafc',        fg: '#94a3b8',        border: '#e2e8f0' },
  info:      { glyph: 'i', bg: tones.info.bg,    fg: tones.info.fg,    border: tones.info.border },
  // Looked into and explained by a person — quiet, but not the green of a verified check.
  overridden:{ glyph: '✓', bg: '#f1f5f9', fg: '#64748b', border: '#cbd5e1' },
};

// ── The finding types ──────────────────────────────────────────────────────
// Three questions, one per type, plus "Other" for the checks that answer none
// of them (engagement letter, BrightPay set-up, TaxCalc, QuickBooks, BM saying
// we are not the agent when HMRC says we are).
const FINDING_TYPES = [
  { key: 'agent',   label: 'Agent missing',   tone: 'danger',
    hint: 'A reference (PAYE, VAT, UTR) is on record but the client is not on our HMRC agent list' },
  { key: 'code',    label: 'Code missing',    tone: 'warning',
    hint: 'The service is on but its reference is not in BrightManager yet (or the one there is wrong)' },
  { key: 'billing', label: 'Billing missing', tone: 'accent',
    hint: 'BrightManager has the service scheduled but no fee line bills it' },
  { key: 'other',   label: 'Other',           tone: 'neutral',
    hint: 'Engagement letter, BrightPay, TaxCalc, QuickBooks and BrightManager mismatches' },
];
const TYPE_LABEL = Object.fromEntries(FINDING_TYPES.map((t) => [t.key, t.label]));

function Dot({ cell, onClick }) {
  if (!cell) {
    // Not a service for this client — a faint dash, so the eye skips it.
    return <span style={{ color: '#e2e8f0', fontSize: 13 }}>–</span>;
  }
  const m = MARK[cell.override ? 'overridden' : cell.state] || MARK.nodata;
  return (
    <button
      type="button"
      onClick={onClick}
      title={cell.override ? `Overridden: ${cell.override.comment}` : cell.title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
        width: 20, height: 20, borderRadius: 6, fontSize: 12.5, fontWeight: 700, fontFamily: font,
        background: m.bg, color: m.fg, border: `1px solid ${m.border}`, cursor: 'pointer',
      }}
    >
      {m.glyph}
    </button>
  );
}

// ── Deriving each cell from the board row ──────────────────────────────────
// A cell is { state, title, types }. `types` lists the findings it carries;
// a cell with none is not a finding (in progress, unverified, no feed, fine).
const inList = (csv, tax) => Boolean(csv) && csv.split(', ').includes(tax);

function finding(issues) {
  return {
    state: 'bad',
    types: [...new Set(issues.map((i) => i.type))],
    title: issues.map((i) => `${TYPE_LABEL[i.type]}: ${i.text}`).join(' · '),
  };
}

function taxCell(r, tax) {
  const name = TAX_LABELS[tax];
  const issues = [];
  const companySa = tax === 'sa' && r.entity_type === 'limited_company';

  if (companySa) {
    if (!r.directors_billed_for_sa) return null;
    if (r.directors_sa_not_authorised > 0) {
      issues.push({ type: 'agent', text: `${r.directors_sa_not_authorised} director(s) we bill SA for are not on our HMRC agent list` });
    }
    if (r.directors_sa_no_utr > 0) {
      issues.push({ type: 'code', text: `${r.directors_sa_no_utr} director(s) have no UTR on record — add it here` });
    }
  } else {
    if (tax === 'vat' && r.vat_ref_flag && r.vat_ref_flag !== 'aliased') {
      issues.push({ type: 'code', text: r.vat_ref_note });
    }
    if (inList(r.unauthorised_taxes, tax)) {
      issues.push({ type: 'agent', text: `${name} reference is on record but the client is not on our HMRC agent list` });
    }
    if (inList(r.awaiting_taxes, tax)) {
      issues.push({ type: 'code', text: `${name} is a service but there is no reference in BrightManager yet` });
    }
  }
  if (inList(r.bm_wrong_taxes, tax)) {
    issues.push({ type: 'other', text: `HMRC shows us as ${name} agent but BrightManager says we are not — update BrightManager` });
  }
  if (issues.length) return finding(issues);

  if (companySa) {
    if (r.directors_sa_unverified > 0) {
      return { state: 'unverified', types: [], title: `Directors' SA: ${r.directors_sa_unverified} not yet confirmed (HMRC check incomplete)` };
    }
    if (r.directors_sa_authorised > 0) {
      return { state: 'ok', types: [], title: `Directors' SA: all ${r.directors_sa_authorised} confirmed against HMRC` };
    }
    return { state: 'nodata', types: [], title: "Directors' SA: no directors recorded for this company" };
  }
  if (tax === 'vat' && r.vat_ref_flag === 'aliased') return { state: 'unverified', types: [], title: r.vat_ref_note };
  if (inList(r.unverified_taxes, tax)) {
    return { state: 'unverified', types: [], title: `${name}: not on HMRC's agent list, but the HMRC check is incomplete — proves nothing yet` };
  }
  const does = { ct: r.does_accounts_ct, sa: r.does_sa, vat: r.does_vat, paye: r.does_payroll }[tax];
  if (!does) return null;
  return { state: 'ok', types: [], title: `${name}: authorised at HMRC and the reference is on record` };
}

function loeCell(r) {
  if (r.loe_signed) {
    return {
      state: 'ok', types: [],
      title: `Letter of engagement signed${r.loe_signed_at ? ` ${new Date(r.loe_signed_at).toLocaleDateString('en-GB')}` : ''}`,
    };
  }
  if (r.has_onboarding) return finding([{ type: 'other', text: 'No letter of engagement signed — in Athena or BrightManager' }]);
  return { state: 'nodata', types: [], title: 'No onboarding record, so no engagement letter is tracked for this client' };
}

function bpCell(r) {
  // A BrightPay payroll with no payroll service is a billing question — see billingCell.
  if (!r.does_payroll) return null;
  if (!r.paye_registered) {
    return { state: 'awaiting', types: [], title: 'No PAYE reference yet — BrightPay set-up waits for it (see PAYE)' };
  }
  if (r.brightpay_missing) {
    return finding([{ type: 'other', text: 'Payroll is a service and the PAYE scheme exists, but no BrightPay employer matches this client' }]);
  }
  return { state: 'ok', types: [], title: `On BrightPay as ${r.brightpay_employer || 'a matched employer'}` };
}

function tcCell(r) {
  if (!r.does_accounts_ct && !r.does_sa) return null;
  if (r.missing_from_taxcalc === null || r.missing_from_taxcalc === undefined) {
    return { state: 'nodata', types: [], title: 'No TaxCalc data yet' };
  }
  if (r.taxcalc_missing) return finding([{ type: 'other', text: 'Accounts / SA work is on, the UTR exists, and the client is not in TaxCalc' }]);
  return { state: 'ok', types: [], title: 'In TaxCalc' };
}

function qboCell(r) {
  if (!r.does_software) return null;
  if (r.software_without_qbo) return finding([{ type: 'other', text: 'Software is billed but no QuickBooks company is connected' }]);
  return { state: 'ok', types: [], title: 'QuickBooks connected' };
}

// Billing has its own mark, so it is overridden on its own (e.g. billed
// through another company in the group) without hiding an agent or code finding.
function billingCell(r) {
  const issues = (r.billing_missing_taxes ? r.billing_missing_taxes.split(', ') : [])
    .map((t) => ({ type: 'billing', text: `BrightManager has ${TAX_LABELS[t] || t} scheduled but no fee line bills it` }));
  if (r.payroll_unbilled) issues.push({ type: 'billing', text: 'We run this payroll on BrightPay and nothing bills it' });
  if (r.brightpay_without_payroll_service) {
    issues.push({ type: 'billing', text: `BrightPay runs a payroll for this client (${r.brightpay_employer || 'employer'}) but no fee or scheduled work covers it` });
  }
  if (issues.length) return finding(issues);
  if (!(r.does_accounts_ct || r.does_sa || r.does_vat || r.does_payroll)) return null;
  return { state: 'ok', types: [], title: 'Every service BrightManager schedules has a fee line' };
}

const CELLS = [
  { key: 'loe',  label: 'Engagement',  get: loeCell },
  { key: 'ct',   label: 'CT',   tax: 'ct',   get: (r) => taxCell(r, 'ct') },
  { key: 'sa',   label: 'SA',   tax: 'sa',   get: (r) => taxCell(r, 'sa') },
  { key: 'vat',  label: 'VAT',  tax: 'vat',  get: (r) => taxCell(r, 'vat') },
  { key: 'paye', label: 'PAYE', tax: 'paye', get: (r) => taxCell(r, 'paye') },
  { key: 'billing', label: 'Billing', get: billingCell },
  { key: 'bp',   label: 'BrightPay', get: bpCell },
  { key: 'tc',   label: 'TaxCalc', get: tcCell },
  { key: 'qbo',  label: 'QBO',  get: qboCell },
];

// Every cell of a row with its override attached. An override counts only
// while the check reads exactly as it did when it was made.
function rowCells(r, overrides) {
  const out = {};
  for (const c of CELLS) {
    const cell = c.get(r);
    if (!cell) { out[c.key] = null; continue; }
    const o = overrides[`${r.entity_id}:${c.key}`];
    const live = o && cell.types.length && o.issue === cell.title ? o : null;
    out[c.key] = { ...cell, override: live, staleOverride: o && !live ? o : null };
  }
  return out;
}

// Open findings (not overridden) and whether anything was overridden.
function rowSummary(cells) {
  const open = new Set();
  let explained = false;
  for (const cell of Object.values(cells)) {
    if (!cell || !cell.types.length) continue;
    if (cell.override) explained = true;
    else cell.types.forEach((t) => open.add(t));
  }
  return { open, explained };
}

// ── Small pieces ───────────────────────────────────────────────────────────
function Tile({ label, count, tone, active, onClick, hint }) {
  const t = tones[tone] || tones.neutral;
  return (
    <button
      onClick={onClick}
      title={hint}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
        padding: '8px 14px', minWidth: 92, borderRadius: 10, cursor: 'pointer', fontFamily: font,
        background: active ? t.bg : '#fff',
        border: `1px solid ${active ? t.border : '#e5e7eb'}`,
      }}
    >
      <span style={{ fontSize: 19, fontWeight: 700, color: count ? t.fg : '#cbd5e1', lineHeight: 1.1 }}>{count}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>{label}</span>
    </button>
  );
}

const detailsSummaryStyle = {
  fontSize: 13.5, fontWeight: 600, color: '#64748b', cursor: 'pointer',
  padding: '10px 16px', userSelect: 'none',
};

function TaxDetail({ entityId, tax }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    listCrossCheckTaxes(entityId)
      .then((d) => setRows(tax ? d.filter((x) => x.tax === tax) : d))
      .catch((e) => setError(e.message));
  }, [entityId, tax]);

  if (error) return <div style={{ fontSize: 13.5, color: tones.danger.fg }}>{error}</div>;
  if (!rows) return <div style={{ fontSize: 13.5, color: '#94a3b8' }}>Loading…</div>;
  if (!rows.length) return <div style={{ fontSize: 13.5, color: '#94a3b8' }}>No tax authorisations to compare.</div>;

  const tone = (v) => ({
    authorised: 'success', bm_wrong: 'accent', not_authorised: 'danger',
    invalid_reference: 'accent', reference_disputed: 'accent',
    unverified: 'warning', no_evidence: 'neutral', agent_but_no_service: 'info',
  }[v] || 'neutral');

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
      <thead>
        <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
          <th style={{ padding: '4px 8px', fontWeight: 600 }}>Tax</th>
          <th style={{ padding: '4px 8px', fontWeight: 600 }}>We do it</th>
          <th style={{ padding: '4px 8px', fontWeight: 600 }}>BrightManager</th>
          <th style={{ padding: '4px 8px', fontWeight: 600 }}>HMRC</th>
          <th style={{ padding: '4px 8px', fontWeight: 600 }}>Verdict</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.tax} style={{ borderTop: '1px solid #f1f5f9' }}>
            <td style={{ padding: '6px 8px', fontWeight: 600, color: '#0f172a' }}>{TAX_LABELS[r.tax] || r.tax}</td>
            <td style={{ padding: '6px 8px', color: '#475569' }}>
              {r.we_do
                ? [r.is_billed && 'billed', r.is_scheduled && 'scheduled in BM',
                   r.is_flagged && 'flagged in onboarding / reference on record']
                    .filter(Boolean).join(' · ')
                : <span style={{ color: '#94a3b8' }}>not a service</span>}
            </td>
            <td style={{ padding: '6px 8px' }}>
              {r.bm_agent === null
                ? <span style={{ ...chipStyle('neutral'), opacity: 0.7 }}>no data</span>
                : <span style={chipStyle(r.bm_agent ? 'success' : 'danger')}>{r.bm_agent ? 'agent' : 'not agent'}</span>}
            </td>
            <td style={{ padding: '6px 8px' }}>
              <span style={chipStyle(r.hmrc_agent ? 'success' : 'neutral')}>
                {r.hmrc_agent ? 'on HMRC list — we are the agent' : 'not on the list'}
              </span>
              {/* Which key resolved this account to the client. A name is a
                  label, not an identity, so it is called out. */}
              {r.hmrc_agent && (
                <div style={{ marginTop: 3 }}>
                  <span style={chipStyle(r.hmrc_link_basis === 'name' ? 'warning' : 'neutral')}>
                    {r.hmrc_link_basis === 'utr' ? 'matched on UTR'
                      : r.hmrc_link_basis === 'vrn' ? 'matched on VRN'
                      : r.hmrc_link_basis === 'paye_ref' ? 'matched on PAYE ref'
                      : r.hmrc_link_basis === 'name' ? 'matched on name only'
                      : `matched: ${r.hmrc_link_basis}`}
                  </span>
                </div>
              )}
            </td>
            <td style={{ padding: '6px 8px' }}>
              <span style={chipStyle(tone(r.verdict))}>{r.verdict?.replace(/_/g, ' ')}</span>
              <div style={{ color: '#64748b', marginTop: 3, lineHeight: 1.45 }}>{r.verdict_detail}</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Directors' Self Assessment for a company whose fee covers directors'
// returns. The fee sits on the company and the authorisation sits on a person,
// so this is the only place the two meet. Where a director has no UTR anywhere,
// it can be typed in here — the check matches on the UTR itself, so it runs as
// soon as one is recorded.
function DirectorSa({ companyId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(null);

  const load = useCallback(() => {
    listDirectorSa(companyId).then(setRows).catch((e) => setError(e.message));
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  async function save(personId) {
    setSaving(personId);
    setError(null);
    try {
      await setPersonUtr(personId, draft[personId]);
      setDraft((d) => ({ ...d, [personId]: '' }));
      load();
    } catch (e) { setError(e.message); }
    setSaving(null);
  }

  if (error) return <div style={{ fontSize: 13.5, color: tones.danger.fg }}>{error}</div>;
  if (!rows) return <div style={{ fontSize: 13.5, color: '#94a3b8' }}>Loading directors…</div>;
  if (!rows.length) return null;

  const tone = (v) => ({
    authorised: 'success', not_authorised: 'danger', unverified: 'warning', no_utr: 'neutral',
  }[v] || 'neutral');

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 6 }}>
        Directors&apos; Self Assessment
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
        <thead>
          <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
            <th style={{ padding: '4px 8px', fontWeight: 600 }}>Director</th>
            <th style={{ padding: '4px 8px', fontWeight: 600 }}>UTR</th>
            <th style={{ padding: '4px 8px', fontWeight: 600 }}>HMRC</th>
            <th style={{ padding: '4px 8px', fontWeight: 600 }}>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.person_id} style={{ borderTop: '1px solid #f1f5f9' }}>
              <td style={{ padding: '6px 8px', color: '#0f172a', fontWeight: 600 }}>
                {d.director_name || '—'}
                {d.director_entity_name && (
                  <div style={{ fontSize: 12, fontWeight: 400, color: '#94a3b8', marginTop: 1 }}>
                    also a client: {d.director_entity_name}
                  </div>
                )}
              </td>
              <td style={{ padding: '6px 8px' }}>
                {d.utr ? (
                  <>
                    <span style={{ fontFamily: 'monospace', color: '#334155' }}>{d.utr}</span>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 1 }}>{d.utr_source}</div>
                  </>
                ) : (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      value={draft[d.person_id] || ''}
                      onChange={(e) => setDraft((x) => ({ ...x, [d.person_id]: e.target.value }))}
                      placeholder="10-digit UTR"
                      style={{ padding: '4px 8px', fontSize: 13.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, width: 130 }}
                    />
                    <button
                      onClick={() => save(d.person_id)}
                      disabled={saving === d.person_id || !(draft[d.person_id] || '').trim()}
                      style={BTN.secondary.sm}
                    >
                      {saving === d.person_id ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                )}
              </td>
              <td style={{ padding: '6px 8px' }}>
                <span style={chipStyle(d.on_sa_list ? 'success' : 'neutral')}>
                  {d.on_sa_list ? 'on the SA list' : 'not on the list'}
                </span>
              </td>
              <td style={{ padding: '6px 8px' }}>
                <span style={chipStyle(tone(d.verdict))}>{d.verdict?.replace(/_/g, ' ')}</span>
                <div style={{ color: '#64748b', marginTop: 3, lineHeight: 1.45 }}>{d.verdict_detail}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── The mark modal ─────────────────────────────────────────────────────────
// One mark, its evidence, and the override. Kept to what a person needs to
// decide: what the check says, why, and "this is fine because…".
function MarkModal({ row, check, cell, onClose, onChanged }) {
  const [comment, setComment] = useState(cell.staleOverride?.comment || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isFinding = cell.types.length > 0;
  const m = MARK[cell.override ? 'overridden' : cell.state] || MARK.nodata;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try { await fn(); onChanged(); onClose(); }
    catch (e) { setError(e.message); setBusy(false); }
  }

  const companySa = check.key === 'sa' && row.entity_type === 'limited_company';

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)', zIndex: 1000,
               display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8vh 16px', overflow: 'auto' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...card, width: '100%', maxWidth: check.tax ? 760 : 520, padding: 20, fontFamily: font,
                 boxShadow: '0 20px 50px rgba(15,23,42,0.18)' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, color: '#94a3b8', fontWeight: 600 }}>{row.entity_name}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>
              {check.tax ? TAX_LABELS[check.tax] : check.label}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 14 }}>
          <span style={{
            flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 6, fontSize: 13, fontWeight: 700,
            background: m.bg, color: m.fg, border: `1px solid ${m.border}`,
          }}>{m.glyph}</span>
          <div style={{ fontSize: 14, color: '#334155', lineHeight: 1.5 }}>
            {cell.title.split(' · ').map((line) => <div key={line}>{line}</div>)}
          </div>
        </div>

        {check.tax && !companySa && (
          <div style={{ marginTop: 16 }}><TaxDetail entityId={row.entity_id} tax={check.tax} /></div>
        )}
        {companySa && <DirectorSa companyId={row.entity_id} />}

        {isFinding && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid #f1f5f9' }}>
            {cell.override ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#475569' }}>
                  Overridden {new Date(cell.override.created_at).toLocaleDateString('en-GB')}
                </div>
                <div style={{ fontSize: 14, color: '#334155', marginTop: 4, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {cell.override.comment}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                  <button disabled={busy} onClick={() => run(() => clearCrossCheckOverride(row.entity_id, check.key))} style={BTN.secondary.md}>
                    {busy ? 'Removing…' : 'Remove override'}
                  </button>
                </div>
              </>
            ) : (
              <>
                {cell.staleOverride && (
                  <div style={{ fontSize: 13, color: '#92400e', background: tones.warning.bg, border: `1px solid ${tones.warning.border}`, borderRadius: 8, padding: '8px 10px', marginBottom: 10, lineHeight: 1.45 }}>
                    An earlier override no longer applies — the check now says something different. Its comment is below.
                  </div>
                )}
                <div style={{ fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 6 }}>Override — this is fine because…</div>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                  placeholder="e.g. Billed through the parent company's fee"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 14, fontFamily: font,
                           border: '1px solid #cbd5e1', borderRadius: 8, resize: 'vertical' }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                  <button
                    disabled={busy || !comment.trim()}
                    onClick={() => run(() => setCrossCheckOverride(row.entity_id, check.key, cell.title, comment))}
                    style={{ ...BTN.primary.md, opacity: busy || !comment.trim() ? 0.5 : 1 }}
                  >
                    {busy ? 'Saving…' : 'Override'}
                  </button>
                </div>
              </>
            )}
            {error && <div style={{ color: tones.danger.fg, fontSize: 13.5, marginTop: 8 }}>{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── The page ───────────────────────────────────────────────────────────────
export default function CrossCheckView() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [coverage, setCoverage] = useState([]);
  const [orphans, setOrphans] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [overrideRows, setOverrideRows] = useState([]);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('issues'); // issues | <finding type> | explained | all
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null); // { entityId, key }

  const loadOverrides = useCallback(() => {
    listCrossCheckOverrides().then(setOverrideRows).catch((e) => setError(e.message));
  }, []);

  const load = useCallback(() => {
    Promise.all([listCrossCheck(), listCrossCheckBillingMissing()])
      .then(([board, billing]) => {
        const byEntity = Object.fromEntries(billing.map((b) => [b.entity_id, b.billing_missing_taxes]));
        setRows(board.map((r) => ({ ...r, billing_missing_taxes: byEntity[r.entity_id] || null })));
      })
      .catch((e) => setError(e.message));
    loadOverrides();
    getCrossCheckCoverage().then(setCoverage).catch(() => {});
    listCrossCheckOrphans().then(setOrphans).catch(() => {});
    listCrossCheckLinkConflicts().then(setConflicts).catch(() => {});
  }, [loadOverrides]);
  useEffect(() => { load(); }, [load]);

  const overrides = useMemo(
    () => Object.fromEntries(overrideRows.map((o) => [`${o.entity_id}:${o.check_key}`, o])),
    [overrideRows],
  );

  // Each row with its cells and summary, open findings first.
  const derived = useMemo(() => (rows || [])
    .map((r) => {
      const cells = rowCells(r, overrides);
      return { r, cells, ...rowSummary(cells) };
    })
    .sort((a, b) => (b.open.size > 0) - (a.open.size > 0) || a.r.entity_name.localeCompare(b.r.entity_name)),
  [rows, overrides]);

  const counts = useMemo(() => {
    const c = { issues: 0, explained: 0, all: derived.length };
    FINDING_TYPES.forEach((t) => { c[t.key] = 0; });
    derived.forEach((d) => {
      if (d.open.size) c.issues += 1;
      else if (d.explained) c.explained += 1;
      d.open.forEach((t) => { c[t] += 1; });
    });
    return c;
  }, [derived]);

  const filtered = useMemo(() => derived.filter((d) => {
    if (filter === 'issues' && !d.open.size) return false;
    if (filter === 'explained' && (d.open.size || !d.explained)) return false;
    if (TYPE_LABEL[filter] && !d.open.has(filter)) return false;
    if (search && !d.r.entity_name?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [derived, filter, search]);

  const saCover = coverage.find((c) => c.tax === 'sa');
  const partial = coverage.filter((c) => c.scrape_looks_partial);

  const openRow = open && derived.find((d) => d.r.entity_id === open.entityId);
  const openCheck = open && CELLS.find((c) => c.key === open.key);
  const openCell = openRow && openRow.cells[open.key];

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Cross-check</h1>
          <p style={{ margin: '4px 0 0', fontSize: 14, color: '#64748b' }}>
            Where BrightManager, HMRC, billing, BrightPay, TaxCalc and QuickBooks disagree — click a mark to look into it.
          </p>
        </div>
        <ViewTabs active="Cross-check" />
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 14, marginBottom: 10 }}>{error}</div>}

      {/* One row of numbers. Each is a filter; the hover carries the meaning. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <Tile label="Needs a look" count={counts.issues} tone="danger"
              active={filter === 'issues'} onClick={() => setFilter('issues')}
              hint="Every client with at least one finding not yet overridden" />
        {FINDING_TYPES.map((t) => (
          <Tile key={t.key} label={t.label} count={counts[t.key]} tone={t.tone}
                active={filter === t.key} onClick={() => setFilter(t.key)} hint={t.hint} />
        ))}
        <Tile label="Explained" count={counts.explained} tone="neutral"
              active={filter === 'explained'} onClick={() => setFilter('explained')}
              hint="Every finding on these clients has been overridden with a comment" />
        <Tile label="All" count={counts.all} tone="neutral"
              active={filter === 'all'} onClick={() => setFilter('all')}
              hint="Every active client" />
        <input
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client…"
          style={{ marginLeft: 'auto', padding: '6px 12px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 10, minWidth: 200, alignSelf: 'center' }}
        />
      </div>

      {/* The single caveat that changes how the marks read, one line. */}
      {partial.length > 0 && (
        <div
          style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10 }}
          title={saCover
            ? `The Self Assessment run only keeps clients HMRC flags as having a statement, so the HMRC check reached ${saCover.hmrc_clients} of ${saCover.we_do_clients} registered clients. Until it covers them all, absence proves nothing, so those marks read ~ instead of ✕.`
            : undefined}
        >
          {partial.map((c) => TAX_LABELS[c.tax] || c.tax).join(' and ')} HMRC check incomplete — ~ means not yet confirmed.
        </div>
      )}

      {!rows ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...card, padding: '28px 20px', textAlign: 'center', fontSize: 14.5, color: '#64748b' }}>
          Nothing here.
        </div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#fbfcfd', borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ padding: '9px 8px 9px 14px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#64748b' }}>Client</th>
                {CELLS.map((c) => (
                  <th key={c.key} style={{ padding: '9px 4px', width: 64, textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#64748b' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ r, cells }) => (
                <tr key={r.entity_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '7px 8px 7px 14px' }}>
                    <span
                      onClick={() => navigate(r.onboarding_id ? `/onboarding/${r.onboarding_id}` : `/clients/${r.entity_id}`)}
                      title={r.has_onboarding ? `On the board · ${ONBOARDING_STATUSES.find((s) => s.value === r.onboarding_status)?.label || r.onboarding_status} — click to open` : 'No onboarding record — click to open the client'}
                      style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', cursor: 'pointer' }}
                    >
                      {r.entity_name}
                    </span>
                  </td>
                  {CELLS.map((c) => (
                    <td key={c.key} style={{ padding: '7px 4px', textAlign: 'center' }}>
                      <Dot cell={cells[c.key]} onClick={() => setOpen({ entityId: r.entity_id, key: c.key })} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '8px 14px', borderTop: '1px solid #f1f5f9', fontSize: 12.5, color: '#94a3b8' }}>
            ✕ finding · ✓ verified · grey ✓ overridden · ○ in progress · ~ unverified while the HMRC check is incomplete · ? no feed · – not a service
            &nbsp;— click a mark to look into it
          </div>
        </div>
      )}

      {openRow && openCheck && openCell && (
        <MarkModal
          row={openRow.r}
          check={openCheck}
          cell={openCell}
          onClose={() => setOpen(null)}
          onChanged={loadOverrides}
        />
      )}

      {/* The side-lists, folded away until wanted. */}
      {conflicts.length > 0 && (
        <details style={{ ...card, marginTop: 14 }}>
          <summary style={detailsSummaryStyle}>
            {conflicts.length} HMRC account{conflicts.length === 1 ? '' : 's'} tied to a client by something weaker than a reference
          </summary>
          <div style={{ padding: '0 16px 14px' }}>
            <div style={{ fontSize: 13.5, color: '#64748b', marginBottom: 8, lineHeight: 1.5 }}>
              SA, CT and VAT resolve on the UTR or VRN, so they cannot drift. A PAYE account has no UTR, so these
              links rest on a name or a tidied-up reference — and authorisation for the wrong account would look
              like authorisation.
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
              <tbody>
                {conflicts.map((c) => (
                  <tr key={`${c.tax}-${c.hmrc_key}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '6px 8px', fontWeight: 600, color: '#0f172a' }}>{c.entity_name}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#334155' }}>{c.hmrc_key}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#334155' }}>
                      {c.athena_key || <span style={{ color: '#94a3b8', fontFamily: font }}>nothing in Athena</span>}
                    </td>
                    <td style={{ padding: '6px 8px', color: '#64748b' }}>{c.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {orphans.length > 0 && (
        <details style={{ ...card, marginTop: 10 }}>
          <summary style={detailsSummaryStyle}>
            {orphans.length} BrightPay payroll{orphans.length === 1 ? '' : 's'} matching no client
          </summary>
          <div style={{ padding: '0 16px 14px' }}>
            <div style={{ fontSize: 13.5, color: '#64748b', marginBottom: 8, lineHeight: 1.5 }}>
              We run these payrolls but the employer name matches nothing on the client list — a client recorded
              under a different name, or a payroll nobody is billed for.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {orphans.map((o) => (
                <span key={o.employer_id} style={{
                  fontSize: 13.5, padding: '5px 10px', borderRadius: 8,
                  border: '1px solid #e5e7eb', color: '#334155', background: '#fff',
                }}>
                  {o.employer_name}
                  {o.brightpay_active === false && <span style={{ ...chipStyle('neutral'), marginLeft: 6 }}>inactive</span>}
                </span>
              ))}
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
