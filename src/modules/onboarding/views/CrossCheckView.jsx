import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronRight, Check } from 'lucide-react';
import { tones, chipStyle, pillStyle } from '../../../lib/tokens';
import ViewTabs from '../components/ViewTabs';
import {
  listCrossCheck, listCrossCheckTaxes, getCrossCheckCoverage, listCrossCheckOrphans,
  CROSSCHECK_VERDICTS, crosscheckVerdictMeta, TAX_LABELS,
} from '../api';

/*
  Cross-check — the sense check on the onboarding board.

  Every column here is somebody else's record, not ours: BrightManager's view
  of who we act for, whether the HMRC scrape can reach the client (if it can,
  we ARE the agent), whether BrightPay holds the payroll, whether the client
  exists in TaxCalc, whether QuickBooks is connected. Where they disagree with
  the checklist, the other system usually wins.

  The one thing this screen must never do is turn missing evidence into a
  finding. A leg with no feed reads "no data"; a scrape that only reached a
  third of the clients we act for reads "unverified" and says so in the
  Evidence strip. See sql/243_onboarding_crosscheck.sql.
*/

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };

// A tri-state cell: true / false / null-means-we-don't-know.
function Flag({ value, good, bad, unknown = 'no data' }) {
  if (value === null || value === undefined) {
    return <span style={{ ...chipStyle('neutral'), opacity: 0.7 }}>{unknown}</span>;
  }
  return value
    ? <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 3 }}><AlertTriangle size={9} /> {bad}</span>
    : <span style={{ ...chipStyle('success'), display: 'inline-flex', alignItems: 'center', gap: 3 }}><Check size={9} /> {good}</span>;
}

// How much the evidence behind each leg can actually carry.
function EvidenceStrip({ coverage }) {
  if (!coverage.length) return null;
  const partial = coverage.filter((c) => c.scrape_looks_partial);
  return (
    <div style={{ ...card, padding: '14px 18px', marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>
        Evidence quality — read this before believing a column
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {coverage.map((c) => {
          const pct = c.coverage_ratio == null ? null : Math.round(Number(c.coverage_ratio) * 100);
          return (
            <div key={c.tax} style={{
              border: `1px solid ${c.scrape_looks_partial ? tones.warning.border : '#e5e7eb'}`,
              background: c.scrape_looks_partial ? tones.warning.bg : '#fff',
              borderRadius: 10, padding: '8px 12px', minWidth: 150,
            }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a' }}>{TAX_LABELS[c.tax] || c.tax}</div>
              <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>
                HMRC reached {c.hmrc_clients} of {c.we_do_clients}{pct != null ? ` · ${pct}%` : ''}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                {c.last_scrape ? `scraped ${new Date(c.last_scrape).toLocaleDateString('en-GB')}` : 'never scraped'}
              </div>
            </div>
          );
        })}
      </div>
      {partial.length > 0 && (
        <div style={{ fontSize: 12.5, color: tones.warning.fg, marginTop: 10, lineHeight: 1.5 }}>
          {partial.map((c) => TAX_LABELS[c.tax] || c.tax).join(' and ')}: the scrape reached too few of the clients we
          act for to treat absence as missing authorisation. Those clients read <strong>unverified</strong> rather than
          counting against them — confirm the scrape covers the whole agent list, then they will resolve either way.
        </div>
      )}
      <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 8, lineHeight: 1.5 }}>
        BrightManager's agent fields and TaxCalc have no feed into Athena yet, so those columns read
        <span style={{ ...chipStyle('neutral'), margin: '0 4px' }}>no data</span>
        rather than passing or failing. Everything else is live.
      </div>
    </div>
  );
}

// The per-tax authorisation detail behind one client, loaded on expand.
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
                ? [r.is_billed && 'billed', r.is_scheduled && 'scheduled in BM'].filter(Boolean).join(' · ')
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

export default function CrossCheckView() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [coverage, setCoverage] = useState([]);
  const [orphans, setOrphans] = useState([]);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('problems'); // problems | <verdict> | wrongly_closed | ready | all
  const [scope, setScope] = useState('all');        // all | onboarding
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState({});

  const load = useCallback(() => {
    listCrossCheck().then(setRows).catch((e) => setError(e.message));
    getCrossCheckCoverage().then(setCoverage).catch(() => {});
    listCrossCheckOrphans().then(setOrphans).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c = { problems: 0, wrongly_closed: 0, ready: 0, all: 0 };
    (rows || []).forEach((r) => {
      c.all += 1;
      if (r.verdict !== 'clean') c.problems += 1;
      if (r.wrongly_closed) c.wrongly_closed += 1;
      if (r.ready_to_close) c.ready += 1;
      c[r.verdict] = (c[r.verdict] || 0) + 1;
    });
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (scope === 'onboarding' && !r.has_onboarding) return false;
      if (filter === 'problems' && r.verdict === 'clean') return false;
      if (filter === 'wrongly_closed' && !r.wrongly_closed) return false;
      if (filter === 'ready' && !r.ready_to_close) return false;
      if (!['problems', 'wrongly_closed', 'ready', 'all'].includes(filter) && r.verdict !== filter) return false;
      if (search && !r.entity_name?.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [rows, filter, scope, search]);

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Cross-check</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b', maxWidth: 760, lineHeight: 1.5 }}>
            Where the onboarding board disagrees with BrightManager, HMRC, BrightPay, TaxCalc and QuickBooks.
            No engagement letter or no agent authorisation means the client belongs on the board, whatever
            the checklist says.
          </p>
        </div>
        <ViewTabs active="Cross-check" />
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <EvidenceStrip coverage={coverage} />

      {counts.wrongly_closed > 0 && (
        <div style={{
          ...card, borderColor: tones.danger.border, background: tones.danger.bg,
          padding: '12px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <AlertTriangle size={16} color={tones.danger.fg} />
          <span style={{ fontSize: 13.5, color: tones.danger.fg, fontWeight: 600 }}>
            {counts.wrongly_closed} {counts.wrongly_closed === 1 ? 'client is' : 'clients are'} marked
            complete without an engagement letter or an HMRC authorisation
          </span>
          <button onClick={() => setFilter('wrongly_closed')} style={pillStyle({ tone: 'danger', active: filter === 'wrongly_closed' })}>
            Show them
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => setFilter('problems')} style={pillStyle({ tone: 'info', active: filter === 'problems' })}>
          Needs attention ({counts.problems})
        </button>
        {CROSSCHECK_VERDICTS.map((v) => (
          <button key={v.value} onClick={() => setFilter(v.value)} title={v.blurb}
            style={pillStyle({ tone: v.tone, active: filter === v.value })}>
            {v.label} ({counts[v.value] || 0})
          </button>
        ))}
        <button onClick={() => setFilter('ready')} style={pillStyle({ tone: 'success', active: filter === 'ready' })}>
          Ready to close ({counts.ready})
        </button>
        <button onClick={() => setFilter('all')} style={pillStyle({ tone: 'neutral', active: filter === 'all' })}>
          All ({counts.all})
        </button>
        <span style={{ width: 1, height: 22, background: '#e5e7eb', margin: '0 4px' }} />
        <button onClick={() => setScope(scope === 'onboarding' ? 'all' : 'onboarding')}
          style={pillStyle({ tone: 'accent', active: scope === 'onboarding' })}>
          On the board only
        </button>
        <input
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client…"
          style={{ padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, minWidth: 200 }}
        />
      </div>

      {!rows ? (
        <div style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...card, padding: '28px 20px', textAlign: 'center', fontSize: 13.5, color: '#64748b' }}>
          Nothing here — every check that can be answered for these clients answers yes.
        </div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          {filtered.map((r) => {
            const meta = crosscheckVerdictMeta(r.verdict);
            const isOpen = expanded[r.entity_id];
            return (
              <div key={r.entity_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '24px 2fr 1.2fr 2.4fr 2fr', gap: 10, alignItems: 'center', padding: '10px 14px' }}>
                  <button
                    onClick={() => setExpanded((x) => ({ ...x, [r.entity_id]: !x[r.entity_id] }))}
                    title="Show the tax-by-tax comparison"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#94a3b8', display: 'flex' }}
                  >
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>

                  <div>
                    <div
                      onClick={() => navigate(r.onboarding_id ? `/onboarding/${r.onboarding_id}` : `/clients/${r.entity_id}`)}
                      style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a', cursor: 'pointer' }}
                    >
                      {r.entity_name}
                    </div>
                    <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 2 }}>
                      {r.has_onboarding
                        ? `on the board · ${r.onboarding_status}`
                        : 'no onboarding record'}
                      {r.ready_to_close ? ' · nothing left to prove' : ''}
                    </div>
                  </div>

                  <div>
                    <span style={chipStyle(meta.tone)}>{meta.label}</span>
                    {r.wrongly_closed && (
                      <div style={{ ...chipStyle('danger'), marginTop: 4 }}>marked complete</div>
                    )}
                  </div>

                  {/* Engagement + authorisation */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {r.has_onboarding
                      ? <Flag value={!r.loe_signed} good="LOE signed" bad="no LOE" />
                      : <span style={{ ...chipStyle('neutral'), opacity: 0.7 }}>no LOE record</span>}
                    {r.missing_authorisations > 0 && (
                      <span style={chipStyle('danger')}>no HMRC authorisation: {r.unauthorised_taxes}</span>
                    )}
                    {r.bm_disagreements > 0 && (
                      <span style={chipStyle('accent')}>BM wrong: {r.bm_wrong_taxes}</span>
                    )}
                    {r.agent_no_service > 0 && (
                      <span style={chipStyle('info')}>agent, no service ×{r.agent_no_service}</span>
                    )}
                    {r.unverified_taxes && (
                      <span style={chipStyle('warning')}>unverified: {r.unverified_taxes}</span>
                    )}
                  </div>

                  {/* Systems the work runs on */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {r.does_payroll && <Flag value={r.payroll_not_on_brightpay} good="on BrightPay" bad="not on BrightPay" />}
                    {r.brightpay_without_payroll_service && <span style={chipStyle('warning')}>BrightPay, no payroll fee</span>}
                    {(r.does_accounts_ct || r.does_sa) && (
                      <Flag value={r.missing_from_taxcalc} good="in TaxCalc" bad="not in TaxCalc" unknown="TaxCalc: no data" />
                    )}
                    {r.does_software && <Flag value={r.software_without_qbo} good="QBO linked" bad="no QBO" />}
                    {r.vat_service_no_vrn && <span style={chipStyle('danger')}>no VAT number</span>}
                    {r.payroll_no_paye_ref && <span style={chipStyle('danger')}>no PAYE ref</span>}
                    {r.accounts_no_utr && <span style={chipStyle('danger')}>no UTR</span>}
                    {r.company_no_ch_auth_code && <span style={chipStyle('neutral')}>no CH auth code</span>}
                    {r.not_billed && <span style={{ ...chipStyle('neutral'), opacity: 0.8 }}>not in the fee engine</span>}
                  </div>
                </div>

                {isOpen && (
                  <div style={{ padding: '4px 14px 14px 48px', background: '#fbfcfd' }}>
                    <TaxDetail entityId={r.entity_id} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {orphans.length > 0 && (
        <div style={{ ...card, padding: '14px 18px', marginTop: 18 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
            {orphans.length} BrightPay {orphans.length === 1 ? 'payroll' : 'payrolls'} matching no client
          </div>
          <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 10, lineHeight: 1.5 }}>
            We run these payrolls but the employer name matches nothing in the client list — either a client
            recorded under a different name, or a payroll nobody is being billed for.
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
      )}
    </div>
  );
}
