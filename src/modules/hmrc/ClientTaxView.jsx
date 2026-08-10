import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, ChevronRight, ExternalLink, ArrowRight, ArrowLeft, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbp, fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import { font, Pill, Chip, ErrorBar, shortDate, dateTime, th, thNum, td, tdNum, card, inputStyle } from './hmrcShared';

// One client's whole HMRC position: every tax head, and every movement of money
// either way in one chronological ledger.
//
// The ledger is the part that has never existed. A CIS subcontractor builds
// credit on PAYE, we ask HMRC to move it against Corporation Tax and refund the
// rest, and until now the only record of whether that happened was somebody's
// memory. from_another_tax / to_another_tax pairs are that story.

const TAX_META = {
  'paye':            { label: 'PAYE',             colour: '#0e7fe0' },
  'corporation-tax': { label: 'Corporation Tax',  colour: '#7c3aed' },
  'vat':             { label: 'VAT',              colour: '#c2410c' },
  'self-assessment': { label: 'Self Assessment',  colour: '#0369a1' },
};

const MOVEMENT_META = {
  cash_to_client:   { label: 'Repaid to client',   colour: '#059669', icon: ArrowLeft },
  paid_by_client:   { label: 'Paid by client',     colour: '#0f172a', icon: ArrowRight },
  from_another_tax: { label: 'In from other tax',  colour: '#7c3aed', icon: ArrowLeft },
  to_another_tax:   { label: 'Out to other tax',   colour: '#c2410c', icon: ArrowRight },
  internal_ct:      { label: 'Between CT periods', colour: '#64748b', icon: RefreshCw },
  other:            { label: 'Other',              colour: '#94a3b8', icon: RefreshCw },
  unclear:          { label: 'Unclear',            colour: '#94a3b8', icon: RefreshCw },
};

const n = (v) => Number(v || 0);

export default function ClientTaxView() {
  const [params, setParams] = useSearchParams();
  const entityId = params.get('entity') || '';

  const [clients, setClients] = useState([]);
  const [summary, setSummary] = useState([]);
  const [movements, setMovements] = useState([]);
  const [ctPeriods, setCtPeriods] = useState([]);
  const [vatLines, setVatLines] = useState([]);
  const [saPos, setSaPos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [openTax, setOpenTax] = useState(null);
  const [mvFilter, setMvFilter] = useState('all');

  useEffect(() => {
    supabase.from('v_hmrc_client_totals').select('entity_id, entity_name, total, taxes_owing')
      .order('entity_name', { ascending: true })
      .then(({ data, error: e }) => { if (e) setError(e.message); else setClients(data || []); });
  }, []);

  useEffect(() => {
    if (!entityId) { setSummary([]); setMovements([]); setCtPeriods([]); setVatLines([]); setSaPos([]); return; }
    setLoading(true);
    setOpenTax(null);
    Promise.all([
      supabase.from('v_hmrc_client_tax_summary').select('*').eq('entity_id', entityId),
      supabase.from('v_hmrc_money_movements').select('*').eq('entity_id', entityId)
        .order('txn_date', { ascending: false, nullsFirst: false }),
      supabase.from('v_hmrc_ct_periods').select('*').eq('entity_id', entityId)
        .order('period_end', { ascending: false }),
      supabase.from('v_hmrc_vat_owed').select('*').eq('entity_id', entityId)
        .order('period_to', { ascending: false, nullsFirst: false }),
      supabase.from('v_hmrc_sa_position').select('*').eq('entity_id', entityId),
    ])
      .then(([s, m, ct, vat, sa]) => {
        const bad = [s, m, ct, vat, sa].find((r) => r.error);
        if (bad) setError(bad.error.message); else setError('');
        setSummary(s.data || []);
        setMovements(m.data || []);
        setCtPeriods(ct.data || []);
        setVatLines(vat.data || []);
        setSaPos(sa.data || []);
      })
      .catch((e) => setError(e.message || 'Could not load this client'))
      .finally(() => setLoading(false));
  }, [entityId]);

  const pick = (id) => {
    const next = new URLSearchParams(params);
    if (id) next.set('entity', id); else next.delete('entity');
    setParams(next, { replace: false });
  };

  const visibleClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter((c) => {
      const name = c.entity_name || '';
      if (letter && letter !== 'All' && firstCharBucket(name) !== letter) return false;
      return !q || name.toLowerCase().includes(q);
    });
  }, [clients, search, letter]);

  const chosen = clients.find((c) => c.entity_id === entityId);
  const totalOwed = summary.reduce((s, r) => s + n(r.balance), 0);
  const creditHeld = summary.reduce((s, r) => s + n(r.credit_available), 0);

  const shownMovements = mvFilter === 'all'
    ? movements
    : movements.filter((m) => (mvFilter === 'crossing'
        ? ['from_another_tax', 'to_another_tax'].includes(m.movement)
        : m.movement === mvFilter));

  const mvTotal = (kind) => movements
    .filter((m) => m.movement === kind).reduce((s, m) => s + n(m.amount), 0);

  const exportLedger = () => {
    const name = (chosen?.entity_name || entityId).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    downloadCSV(
      `hmrc-ledger-${name}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Date', 'Tax', 'Reference', 'Movement', 'Description', 'Period', 'Amount'],
      shownMovements.map((m) => [
        m.txn_date || '', TAX_META[m.tax]?.label || m.tax, m.reference || '',
        MOVEMENT_META[m.movement]?.label || m.movement,
        m.description || '', m.period || '', n(m.amount).toFixed(2),
      ]),
    );
  };

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 900, marginTop: 0, marginBottom: 12, lineHeight: 1.55 }}>
        One client, every tax head, and every movement of money between them and HMRC in one ledger —
        including credit moved from one tax to another and repayments sent out.
      </p>

      {/* Client picker */}
      <div style={{ ...card, padding: '10px 12px', marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search client…" style={{ minWidth: 280 }} />
          {chosen && (
            <span style={{ fontSize: 12.5, color: '#0f172a' }}>
              <b>{chosen.entity_name}</b>
              <button onClick={() => pick('')}
                style={{ marginLeft: 8, fontSize: 11, color: '#b91c1c', background: 'none', border: 'none', cursor: 'pointer', fontFamily: font }}>
                change
              </button>
            </span>
          )}
        </div>
        <AlphabetFilter items={clients} nameKey="entity_name" selected={letter} onChange={setLetter} />
        {!entityId && (
          <div style={{ maxHeight: 240, overflowY: 'auto', marginTop: 6, borderTop: '1px solid #f1f5f9' }}>
            {visibleClients.map((c) => (
              <button key={c.entity_id} onClick={() => pick(c.entity_id)}
                style={{
                  display: 'flex', width: '100%', alignItems: 'center', gap: 8, textAlign: 'left',
                  padding: '6px 4px', background: 'none', border: 'none',
                  borderBottom: '1px solid #f8fafc', cursor: 'pointer', fontFamily: font, fontSize: 12.5,
                }}>
                <ChevronRight size={12} style={{ color: '#cbd5e1', flexShrink: 0 }} />
                <span style={{ fontWeight: 500, color: '#0f172a' }}>{c.entity_name}</span>
                <span style={{ flex: 1 }} />
                {(c.taxes_owing || 0) > 1 && (
                  <span style={{ fontSize: 10, color: '#c2410c', fontWeight: 600 }}>{c.taxes_owing} taxes</span>
                )}
                {n(c.total) > 0 && (
                  <span style={{ color: '#b91c1c', fontWeight: 600 }}>{fmtGbpDetailed(c.total)}</span>
                )}
              </button>
            ))}
            {visibleClients.length === 0 && (
              <div style={{ fontSize: 12, color: '#94a3b8', padding: '10px 2px' }}>No clients match.</div>
            )}
          </div>
        )}
      </div>

      {!entityId ? (
        <div style={{ ...card, padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          Pick a client to see their position across every tax.
        </div>
      ) : loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading every tax head…</div>
      ) : (
        <>
          {/* One card per tax head */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, marginBottom: 8 }}>
            {Object.keys(TAX_META).map((taxKey) => {
              const row = summary.find((r) => r.tax === taxKey);
              const meta = TAX_META[taxKey];
              const bal = row ? n(row.balance) : null;
              const detailCount = taxKey === 'corporation-tax' ? ctPeriods.length
                : taxKey === 'vat' ? vatLines.length
                : taxKey === 'self-assessment' ? saPos.length : 0;
              return (
                <button
                  key={taxKey}
                  onClick={() => detailCount ? setOpenTax(openTax === taxKey ? null : taxKey) : undefined}
                  title={detailCount ? 'Click for the detail behind this' : 'No detail scraped for this tax'}
                  style={{
                    textAlign: 'left', background: openTax === taxKey ? '#f1f5f9' : '#fff',
                    border: `1px solid ${openTax === taxKey ? '#cbd5e1' : '#e5e7eb'}`,
                    borderLeft: `3px solid ${meta.colour}`, borderRadius: 10, padding: '10px 12px',
                    fontFamily: font, cursor: detailCount ? 'pointer' : 'default',
                  }}
                >
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    {meta.label}
                  </div>
                  {row ? (
                    <>
                      <div style={{ fontSize: 19, fontWeight: 700, marginTop: 2,
                                    color: bal > 0 ? '#b91c1c' : bal < 0 ? '#059669' : '#0f172a' }}>
                        {fmtGbpDetailed(bal)}
                      </div>
                      <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>
                        {row.reference}
                        {row.payment_plan && <span style={{ color: '#0369a1', fontWeight: 600 }}> · payment plan</span>}
                      </div>
                      {n(row.credit_available) > 0 && (
                        <div style={{ fontSize: 10.5, color: '#0369a1', fontWeight: 600, marginTop: 2 }}>
                          {fmtGbpDetailed(row.credit_available)} credit held
                        </div>
                      )}
                      {detailCount > 0 && (
                        <div style={{ fontSize: 10, color: '#0e7fe0', marginTop: 3 }}>
                          {detailCount} {taxKey === 'corporation-tax' ? 'periods' : taxKey === 'vat' ? 'lines' : 'rows'} →
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 6 }}>Not registered / not scraped</div>
                  )}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: '#475569', marginBottom: 14 }}>
            <span><b style={{ color: totalOwed > 0 ? '#b91c1c' : '#0f172a' }}>{fmtGbpDetailed(totalOwed)}</b> owed in total</span>
            {creditHeld > 0 && <span><b style={{ color: '#0369a1' }}>{fmtGbpDetailed(creditHeld)}</b> credit HMRC holds</span>}
            {mvTotal('cash_to_client') > 0 && <span><b style={{ color: '#059669' }}>{fmtGbpDetailed(mvTotal('cash_to_client'))}</b> repaid to client</span>}
            {mvTotal('from_another_tax') > 0 && <span><b style={{ color: '#7c3aed' }}>{fmtGbpDetailed(mvTotal('from_another_tax'))}</b> credit moved in</span>}
            {chosen && (
              <a href={`/clients/${entityId}`} target="_blank" rel="noreferrer"
                 style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#0e7fe0', textDecoration: 'none' }}>
                Client record <ExternalLink size={11} />
              </a>
            )}
          </div>

          {openTax && <TaxDetail taxKey={openTax} ctPeriods={ctPeriods} vatLines={vatLines} saPos={saPos}
                                 onClose={() => setOpenTax(null)} />}

          {/* The ledger */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', marginRight: 4 }}>Money ledger</span>
            <Chip value="all" label="Everything" count={movements.length} active={mvFilter} onClick={setMvFilter} />
            <Chip value="crossing" label="Between taxes" colour="#7c3aed" active={mvFilter} onClick={setMvFilter}
                  count={movements.filter((m) => ['from_another_tax', 'to_another_tax'].includes(m.movement)).length} />
            <Chip value="cash_to_client" label="Repaid out" colour="#059669" active={mvFilter} onClick={setMvFilter}
                  count={movements.filter((m) => m.movement === 'cash_to_client').length} />
            <Chip value="paid_by_client" label="Paid in" active={mvFilter} onClick={setMvFilter}
                  count={movements.filter((m) => m.movement === 'paid_by_client').length} />
            <div style={{ flex: 1 }} />
            <button onClick={exportLedger} disabled={shownMovements.length === 0}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px',
                fontSize: 12, fontFamily: font, color: '#475569', background: '#fff',
                border: '1px solid #e5e7eb', borderRadius: 8,
                cursor: shownMovements.length ? 'pointer' : 'default', opacity: shownMovements.length ? 1 : 0.5,
              }}>
              <Download size={12} /> Export for Excel
            </button>
          </div>

          <div style={card}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: '#64748b' }}>
                    <th style={th}>Date</th>
                    <th style={th}>Tax</th>
                    <th style={th}>Movement</th>
                    <th style={th}>Description</th>
                    <th style={thNum}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {shownMovements.length === 0 && (
                    <tr><td colSpan={5} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                      No movements recorded for this client.
                    </td></tr>
                  )}
                  {shownMovements.map((m, i) => {
                    const mm = MOVEMENT_META[m.movement] || MOVEMENT_META.other;
                    const tm = TAX_META[m.tax] || { label: m.tax, colour: '#94a3b8' };
                    const Icon = mm.icon;
                    return (
                      <tr key={`${m.tax}-${m.txn_date}-${i}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ ...td, whiteSpace: 'nowrap', color: '#64748b' }}>{shortDate(m.txn_date)}</td>
                        <td style={td}>
                          <Pill colour={tm.colour} style={{ fontSize: 10 }}>{tm.label}</Pill>
                        </td>
                        <td style={td}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: mm.colour, fontWeight: 600, fontSize: 11.5 }}>
                            <Icon size={11} /> {mm.label}
                          </span>
                        </td>
                        <td style={{ ...td, color: '#475569', maxWidth: 420, whiteSpace: 'normal' }}>
                          {m.description}
                          {m.period && <span style={{ fontSize: 10.5, color: '#94a3b8', marginLeft: 6 }}>{m.period}</span>}
                        </td>
                        <td style={{ ...tdNum, fontWeight: 600, color: mm.colour }}>{fmtGbpDetailed(m.amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Detail behind one tax head. PAYE deliberately has none here — it already has
// three surfaces of its own, and duplicating them would be a second definition.
function TaxDetail({ taxKey, ctPeriods, vatLines, saPos, onClose }) {
  const head = (title, sub) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{title}</span>
      {sub && <span style={{ fontSize: 11, color: '#94a3b8' }}>{sub}</span>}
      <button onClick={onClose} style={{ marginLeft: 'auto', fontSize: 11, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', fontFamily: font }}>close</button>
    </div>
  );

  if (taxKey === 'corporation-tax') {
    return (
      <div style={{ ...card, padding: '10px 14px', marginBottom: 14 }}>
        {head('Corporation Tax by accounting period', 'newest first')}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead>
              <tr style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase' }}>
                <th style={th}>Period end</th><th style={th}>Status</th>
                <th style={thNum}>Tax</th><th style={thNum}>Interest</th><th style={thNum}>Penalties</th>
                <th style={thNum}>Paid</th><th style={thNum}>Repaid / realloc</th><th style={thNum}>Total</th>
              </tr>
            </thead>
            <tbody>
              {ctPeriods.map((p, i) => (
                <tr key={`${p.period_end}-${i}`} style={{ borderTop: '1px solid #f1f5f9',
                        background: p.unreadable ? '#fffbeb' : undefined }}>
                  <td style={td}>
                    {shortDate(p.period_end)}
                    {p.unreadable && <span style={{ fontSize: 10, color: '#b45309', fontWeight: 600, marginLeft: 5 }}>unreadable</span>}
                  </td>
                  <td style={{ ...td, color: '#64748b', fontSize: 11.5 }}>{p.status || '—'}</td>
                  <td style={tdNum}>{fmtGbpDetailed(p.tax)}</td>
                  <td style={{ ...tdNum, color: n(p.interest) ? '#c2410c' : '#e2e8f0' }}>{n(p.interest) ? fmtGbpDetailed(p.interest) : '—'}</td>
                  <td style={{ ...tdNum, color: n(p.penalties) ? '#b91c1c' : '#e2e8f0' }}>{n(p.penalties) ? fmtGbpDetailed(p.penalties) : '—'}</td>
                  <td style={{ ...tdNum, color: '#059669' }}>{fmtGbpDetailed(p.less_paid)}</td>
                  <td style={{ ...tdNum, color: n(p.repayments_reallocations) ? '#7c3aed' : '#e2e8f0' }}>
                    {n(p.repayments_reallocations) ? fmtGbpDetailed(p.repayments_reallocations) : '—'}
                  </td>
                  <td style={{ ...tdNum, fontWeight: 700, color: n(p.total) > 0 ? '#b91c1c' : '#0f172a' }}>
                    {fmtGbpDetailed(p.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (taxKey === 'vat') {
    return (
      <div style={{ ...card, padding: '10px 14px', marginBottom: 14 }}>
        {head('VAT owed, line by line')}
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase' }}>
              <th style={th}>Description</th><th style={th}>Period</th><th style={th}>Flags</th><th style={thNum}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {vatLines.map((l, i) => (
              <tr key={i} style={{ borderTop: '1px solid #f1f5f9', background: l.overdue ? '#fffbfa' : undefined }}>
                <td style={{ ...td, color: '#475569', whiteSpace: 'normal', maxWidth: 420 }}>{l.description}</td>
                <td style={{ ...td, color: '#64748b', fontSize: 11.5, whiteSpace: 'nowrap' }}>
                  {l.period_from ? `${shortDate(l.period_from)} – ${shortDate(l.period_to)}` : '—'}
                </td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {l.overdue && <Pill colour="#b91c1c" style={{ fontSize: 10 }}>Overdue</Pill>}
                    {l.estimated && <Pill colour="#c2410c" style={{ fontSize: 10 }}
                        title="HMRC has assessed this rather than received a return">Assessed</Pill>}
                  </div>
                </td>
                <td style={{ ...tdNum, fontWeight: 600, color: n(l.amount) > 0 ? '#b91c1c' : '#059669' }}>
                  {fmtGbpDetailed(l.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (taxKey === 'self-assessment') {
    return (
      <div style={{ ...card, padding: '10px 14px', marginBottom: 14 }}>
        {head('Self Assessment position')}
        <table style={{ fontSize: 12, borderCollapse: 'collapse', minWidth: 380 }}>
          <tbody>
            {saPos.map((p, i) => (
              <React.Fragment key={i}>
                {[['Tax', p.tax], ['Surcharges', p.surcharges], ['Interest', p.interest],
                  ['Penalties', p.penalties], ['Total', p.total], ['Amount due', p.amount_due],
                  ['Available for repayment', p.available_for_repayment]].map(([label, v]) => (
                  <tr key={label} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '3px 14px 3px 0', color: label === 'Amount due' ? '#0f172a' : '#64748b',
                                 fontWeight: label === 'Amount due' ? 600 : 400 }}>{label}</td>
                    <td style={{ padding: '3px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                 fontWeight: label === 'Amount due' ? 700 : 400,
                                 color: label === 'Available for repayment' && n(v) > 0 ? '#0369a1'
                                      : n(v) > 0 && label === 'Amount due' ? '#b91c1c' : '#0f172a' }}>
                      {fmtGbpDetailed(v)}
                    </td>
                  </tr>
                ))}
                {p.statement_available === false && (
                  <tr><td colSpan={2} style={{ paddingTop: 6, fontSize: 11, color: '#b45309' }}>
                    HMRC would not show the statement, so a zero here is unknown rather than nil.
                  </td></tr>
                )}
                {p.as_at && (
                  <tr><td colSpan={2} style={{ paddingTop: 4, fontSize: 11, color: '#94a3b8' }}>
                    As at {shortDate(p.as_at)}
                  </td></tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return null;
}
