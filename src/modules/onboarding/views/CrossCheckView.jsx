import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import ViewTabs from '../components/ViewTabs';
import {
  listCrossCheck, listCrossCheckTaxes, getCrossCheckCoverage, listCrossCheckOrphans,
  listCrossCheckLinkConflicts, listDirectorSa, setPersonUtr,
  CROSSCHECK_VERDICTS, crosscheckVerdictMeta, TAX_LABELS,
} from '../api';

/*
  Cross-check — the sense check on the onboarding board.

  The whole page is one matrix: a row per client, a mark per check. Five marks
  tell the story — ✓ verified, ✕ mismatch, ○ in progress, ~ unverifiable while
  the SA scrape is partial, ? no feed. Everything behind a mark is on its hover
  title, and the full evidence (per-tax comparison, directors' SA with inline
  UTR capture) opens on click. Only clients with something to look at show by
  default.

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
  unverified:{ glyph: '~', bg: tones.warning.bg, fg: tones.warning.fg, border: tones.warning.border },
  nodata:    { glyph: '?', bg: '#f8fafc',        fg: '#94a3b8',        border: '#e2e8f0' },
  info:      { glyph: 'i', bg: tones.info.bg,    fg: tones.info.fg,    border: tones.info.border },
};

function Dot({ cell }) {
  if (!cell) {
    // Not a service for this client — a faint dash, so the eye skips it.
    return <span style={{ color: '#e2e8f0', fontSize: 12 }}>–</span>;
  }
  const m = MARK[cell.state] || MARK.nodata;
  return (
    <span
      title={cell.title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, borderRadius: 6, fontSize: 11.5, fontWeight: 700,
        background: m.bg, color: m.fg, border: `1px solid ${m.border}`,
        cursor: cell.title ? 'help' : 'default',
      }}
    >
      {m.glyph}
    </span>
  );
}

// ── Deriving each cell from the board row ──────────────────────────────────
const inList = (csv, tax) => Boolean(csv) && csv.split(', ').includes(tax);

// HMRC authorisation per tax. For a company, the SA cell carries the
// directors' returns we bill through it — the company itself never holds SA.
function taxCell(r, tax) {
  if (tax === 'sa' && r.entity_type === 'limited_company') {
    if (!r.directors_billed_for_sa) return null;
    if (r.directors_sa_not_authorised > 0) {
      return { state: 'bad', title: `Directors' SA: ${r.directors_sa_not_authorised} director(s) we bill for whom HMRC has never shown us as agent` };
    }
    if (r.directors_sa_no_utr > 0) {
      return { state: 'awaiting', title: `Directors' SA: ${r.directors_sa_no_utr} director(s) without a UTR on record — click the row to add one, the check runs immediately` };
    }
    if (r.directors_sa_unverified > 0) {
      return { state: 'unverified', title: `Directors' SA: ${r.directors_sa_unverified} director(s) with a known UTR, not on the scraped SA list — the scrape is partial, so this proves nothing yet` };
    }
    if (r.directors_sa_authorised > 0) {
      return { state: 'ok', title: `Directors' SA: all ${r.directors_sa_authorised} confirmed against HMRC on the director's own UTR` };
    }
    return { state: 'nodata', title: "Directors' SA: no directors recorded for this company" };
  }

  if (inList(r.bm_wrong_taxes, tax)) {
    return { state: 'bad', title: `${TAX_LABELS[tax]}: HMRC lets us scrape this client, so we ARE the agent — BrightManager says otherwise and needs fixing` };
  }
  if (inList(r.unauthorised_taxes, tax)) {
    return { state: 'bad', title: `${TAX_LABELS[tax]}: we do this work but HMRC has never shown this client on our agent list — authorisation is missing` };
  }
  if (inList(r.awaiting_taxes, tax)) {
    return { state: 'awaiting', title: `${TAX_LABELS[tax]}: no reference on record yet, so there is nothing to be authorised for — a registration in progress` };
  }
  if (inList(r.unverified_taxes, tax)) {
    return { state: 'unverified', title: `${TAX_LABELS[tax]}: not on the scraped agent list, but that scrape is partial — proves nothing yet` };
  }
  const does = {
    ct: r.does_accounts_ct, sa: r.does_sa, vat: r.does_vat, paye: r.does_payroll,
  }[tax];
  if (!does) return null;
  return { state: 'ok', title: `${TAX_LABELS[tax]}: authorised at HMRC and the service is switched on` };
}

function loeCell(r) {
  if (r.loe_signed) {
    return {
      state: 'ok',
      title: `Letter of engagement signed${r.loe_signed_at ? ` ${new Date(r.loe_signed_at).toLocaleDateString('en-GB')}` : ''}`
        + (r.loe_from_bm_only ? ' — recorded in BrightManager; Athena’s checklist step was never ticked' : ''),
    };
  }
  if (r.has_onboarding) {
    return { state: 'bad', title: 'No letter of engagement signed — in Athena or BrightManager. The client stays on the board.' };
  }
  return { state: 'nodata', title: 'No onboarding record, so no engagement letter is tracked for this client' };
}

function bpCell(r) {
  if (!r.does_payroll) {
    if (r.brightpay_without_payroll_service) {
      return { state: 'info', title: `BrightPay runs a payroll for this client (${r.brightpay_employer || 'employer'}) but no fee or scheduled work covers it` };
    }
    return null;
  }
  if (!r.paye_registered) {
    return { state: 'awaiting', title: 'Payroll is a service but there is no PAYE reference yet — BrightPay set-up waits for the registration' };
  }
  if (r.brightpay_missing) {
    return { state: 'bad', title: 'Payroll is a service and the PAYE scheme exists, but no BrightPay employer matches this client' };
  }
  return { state: 'ok', title: `On BrightPay as ${r.brightpay_employer || 'a matched employer'}` };
}

function tcCell(r) {
  if (!r.does_accounts_ct && !r.does_sa) return null;
  if (r.missing_from_taxcalc === null || r.missing_from_taxcalc === undefined) {
    return { state: 'nodata', title: 'TaxCalc has no feed into Athena yet — unknown, not failing' };
  }
  if (r.taxcalc_missing) {
    return { state: 'bad', title: 'Accounts / SA work is on, the UTR exists, and the client is not in TaxCalc' };
  }
  return { state: 'ok', title: 'In TaxCalc' };
}

function qboCell(r) {
  if (!r.does_software) return null;
  if (r.software_without_qbo) {
    return { state: 'bad', title: 'Software is billed but no QuickBooks company is connected' };
  }
  return { state: 'ok', title: 'QuickBooks connected' };
}

function feeCell(r) {
  const issues = [];
  if (r.billed_vat_not_registered) issues.push('billed a VAT product while not VAT registered by any record');
  if (r.billed_ct_not_a_company) issues.push('billed a Corporation Tax product but not a limited company');
  if (r.payroll_unbilled) issues.push('we run the payroll on BrightPay and nothing bills it');
  if (!issues.length) return null;
  return { state: 'bad', title: `Fees: ${issues.join('; ')}` };
}

const CELLS = [
  { key: 'loe',  label: 'LOE',  get: loeCell },
  { key: 'ct',   label: 'CT',   get: (r) => taxCell(r, 'ct') },
  { key: 'sa',   label: 'SA',   get: (r) => taxCell(r, 'sa') },
  { key: 'vat',  label: 'VAT',  get: (r) => taxCell(r, 'vat') },
  { key: 'paye', label: 'PAYE', get: (r) => taxCell(r, 'paye') },
  { key: 'bp',   label: 'BPay', get: bpCell },
  { key: 'tc',   label: 'TCalc', get: tcCell },
  { key: 'qbo',  label: 'QBO',  get: qboCell },
  { key: 'fee',  label: 'Fees', get: feeCell },
];

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
      <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>{label}</span>
    </button>
  );
}

const detailsSummaryStyle = {
  fontSize: 12.5, fontWeight: 600, color: '#64748b', cursor: 'pointer',
  padding: '10px 16px', userSelect: 'none',
};

function TaxDetail({ entityId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    listCrossCheckTaxes(entityId).then(setRows).catch((e) => setError(e.message));
  }, [entityId]);

  if (error) return <div style={{ fontSize: 12.5, color: tones.danger.fg }}>{error}</div>;
  if (!rows) return <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Loading…</div>;
  if (!rows.length) return <div style={{ fontSize: 12.5, color: '#94a3b8' }}>No tax authorisations to compare.</div>;

  const tone = (v) => ({
    authorised: 'success', bm_wrong: 'accent', not_authorised: 'danger',
    unverified: 'warning', no_evidence: 'neutral', agent_but_no_service: 'info',
  }[v] || 'neutral');

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
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
                {r.hmrc_agent ? 'scraped — we are the agent' : 'not on the list'}
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

  if (error) return <div style={{ fontSize: 12.5, color: tones.danger.fg }}>{error}</div>;
  if (!rows) return <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Loading directors…</div>;
  if (!rows.length) return null;

  const tone = (v) => ({
    authorised: 'success', not_authorised: 'danger', unverified: 'warning', no_utr: 'neutral',
  }[v] || 'neutral');

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>
        Directors&apos; Self Assessment
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
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
                  <div style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8', marginTop: 1 }}>
                    also a client: {d.director_entity_name}
                  </div>
                )}
              </td>
              <td style={{ padding: '6px 8px' }}>
                {d.utr ? (
                  <>
                    <span style={{ fontFamily: 'monospace', color: '#334155' }}>{d.utr}</span>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{d.utr_source}</div>
                  </>
                ) : (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      value={draft[d.person_id] || ''}
                      onChange={(e) => setDraft((x) => ({ ...x, [d.person_id]: e.target.value }))}
                      placeholder="10-digit UTR"
                      style={{ padding: '4px 8px', fontSize: 12.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, width: 130 }}
                    />
                    <button
                      onClick={() => save(d.person_id)}
                      disabled={saving === d.person_id || !(draft[d.person_id] || '').trim()}
                      style={{
                        padding: '4px 10px', fontSize: 12, fontWeight: 600, fontFamily: font,
                        background: tones.info.bg, color: tones.info.fg,
                        border: `1px solid ${tones.info.border}`, borderRadius: 6, cursor: 'pointer',
                      }}
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

// ── The page ───────────────────────────────────────────────────────────────
export default function CrossCheckView() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [coverage, setCoverage] = useState([]);
  const [orphans, setOrphans] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('issues'); // issues | <verdict> | all
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState({});

  const load = useCallback(() => {
    listCrossCheck().then(setRows).catch((e) => setError(e.message));
    getCrossCheckCoverage().then(setCoverage).catch(() => {});
    listCrossCheckOrphans().then(setOrphans).catch(() => {});
    listCrossCheckLinkConflicts().then(setConflicts).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c = { issues: 0, all: 0 };
    (rows || []).forEach((r) => {
      c.all += 1;
      if (r.verdict !== 'clean') c.issues += 1;
      c[r.verdict] = (c[r.verdict] || 0) + 1;
    });
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (filter === 'issues' && r.verdict === 'clean') return false;
      if (filter !== 'issues' && filter !== 'all' && r.verdict !== filter) return false;
      if (search && !r.entity_name?.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [rows, filter, search]);

  const saCover = coverage.find((c) => c.tax === 'sa');
  const partial = coverage.filter((c) => c.scrape_looks_partial);

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Cross-check</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            Where the onboarding board disagrees with BrightManager, HMRC, BrightPay, TaxCalc and QuickBooks.
          </p>
        </div>
        <ViewTabs active="Cross-check" />
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {/* One row of numbers. Each is a filter; the hover carries the meaning. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <Tile label="Needs a look" count={counts.issues || 0} tone="danger"
              active={filter === 'issues'} onClick={() => setFilter('issues')}
              hint="Every client where at least one check disagrees" />
        {CROSSCHECK_VERDICTS.filter((v) => v.value !== 'clean' && counts[v.value]).map((v) => (
          <Tile key={v.value} label={v.label} count={counts[v.value]} tone={v.tone}
                active={filter === v.value} onClick={() => setFilter(v.value)} hint={v.blurb} />
        ))}
        <Tile label="Verified" count={counts.clean || 0} tone="success"
              active={filter === 'clean'} onClick={() => setFilter('clean')}
              hint={crosscheckVerdictMeta('clean').blurb} />
        <Tile label="All" count={counts.all || 0} tone="neutral"
              active={filter === 'all'} onClick={() => setFilter('all')}
              hint="Every active client" />
        <input
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client…"
          style={{ marginLeft: 'auto', padding: '6px 12px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 10, minWidth: 200, alignSelf: 'center' }}
        />
      </div>

      {/* The single caveat that changes how the marks read, one line. */}
      {partial.length > 0 && (
        <div
          style={{ fontSize: 12, color: tones.warning.fg, marginBottom: 10 }}
          title={saCover
            ? `The Self Assessment run only keeps clients HMRC flags as having a statement, so the scrape reached ${saCover.hmrc_clients} of ${saCover.we_do_clients} registered clients. Publishing the whole client list (already built — needs one live scrape run) closes this. Until then absence proves nothing, so those marks read ~ instead of ✕.`
            : undefined}
        >
          ⚠ {partial.map((c) => TAX_LABELS[c.tax] || c.tax).join(' and ')} scrape is partial — those marks read ~ (unverified), not ✕. Hover for why.
        </div>
      )}

      {!rows ? (
        <div style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...card, padding: '28px 20px', textAlign: 'center', fontSize: 13.5, color: '#64748b' }}>
          Nothing here — every check that can be answered for these clients answers yes.
        </div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#fbfcfd', borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ padding: '9px 6px 9px 14px', width: 24 }} />
                <th style={{ padding: '9px 8px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.4px' }}>Client</th>
                {CELLS.map((c) => (
                  <th key={c.key} style={{ padding: '9px 4px', width: 44, textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.4px' }}>
                    {c.label}
                  </th>
                ))}
                <th style={{ padding: '9px 14px 9px 8px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.4px' }}>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const meta = crosscheckVerdictMeta(r.verdict);
                const isOpen = expanded[r.entity_id];
                return (
                  <React.Fragment key={r.entity_id}>
                    <tr
                      onClick={() => setExpanded((x) => ({ ...x, [r.entity_id]: !x[r.entity_id] }))}
                      style={{ borderTop: '1px solid #f1f5f9', cursor: 'pointer', background: isOpen ? '#fbfcfd' : '#fff' }}
                    >
                      <td style={{ padding: '7px 6px 7px 14px', color: '#94a3b8' }}>
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </td>
                      <td style={{ padding: '7px 8px' }}>
                        <span
                          onClick={(e) => { e.stopPropagation(); navigate(r.onboarding_id ? `/onboarding/${r.onboarding_id}` : `/clients/${r.entity_id}`); }}
                          title={r.has_onboarding ? `On the board · ${r.onboarding_status} — click to open` : 'No onboarding record — click to open the client'}
                          style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}
                        >
                          {r.entity_name}
                        </span>
                        {r.wrongly_closed && (
                          <span
                            title="Marked complete without an engagement letter or an HMRC authorisation"
                            style={{ marginLeft: 6, fontSize: 11 }}
                          >
                            ⚠
                          </span>
                        )}
                      </td>
                      {CELLS.map((c) => (
                        <td key={c.key} style={{ padding: '7px 4px', textAlign: 'center' }}>
                          <Dot cell={c.get(r)} />
                        </td>
                      ))}
                      <td style={{ padding: '7px 14px 7px 8px', textAlign: 'right' }}>
                        <span style={chipStyle(meta.tone)} title={meta.blurb}>{meta.label}</span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={CELLS.length + 3} style={{ padding: '4px 14px 16px 44px', background: '#fbfcfd' }}>
                          <TaxDetail entityId={r.entity_id} />
                          {r.directors_billed_for_sa > 0 && <DirectorSa companyId={r.entity_id} />}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <div style={{ padding: '8px 14px', borderTop: '1px solid #f1f5f9', fontSize: 11.5, color: '#94a3b8' }}>
            ✓ verified · ✕ mismatch · ○ in progress · ~ unverified while the scrape is partial · ? no feed · – not a service
            &nbsp;— hover a mark for the story, click a row for the evidence
          </div>
        </div>
      )}

      {/* The side-lists, folded away until wanted. */}
      {conflicts.length > 0 && (
        <details style={{ ...card, marginTop: 14 }}>
          <summary style={detailsSummaryStyle}>
            {conflicts.length} HMRC account{conflicts.length === 1 ? '' : 's'} tied to a client by something weaker than a reference
          </summary>
          <div style={{ padding: '0 16px 14px' }}>
            <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 8, lineHeight: 1.5 }}>
              SA, CT and VAT resolve on the UTR or VRN, so they cannot drift. A PAYE account has no UTR, so these
              links rest on a name or a tidied-up reference — and authorisation for the wrong account would look
              like authorisation.
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
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
            <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 8, lineHeight: 1.5 }}>
              We run these payrolls but the employer name matches nothing on the client list — a client recorded
              under a different name, or a payroll nobody is billed for.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {orphans.map((o) => (
                <span key={o.employer_id} style={{
                  fontSize: 12.5, padding: '5px 10px', borderRadius: 8,
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
