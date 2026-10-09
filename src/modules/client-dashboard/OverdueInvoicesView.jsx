import React, { useEffect, useMemo, useState } from 'react';
import {
  overdueInvoices, sortByDue, groupByCustomer, summarise, buildStatement,
  money2, dateGB,
} from './openItems';
import { downloadStatements, letterhead } from './statementPdf';
import StatementSettingsForm from './StatementSettingsForm';

/*
  Overdue invoices — one row per invoice, as at a date, with customer
  statements to download.

  Rendered by BOTH apps: the staff Client Dashboard tab and the client's own
  portal dashboard (and so the "Preview as client" panel). Pure presentation,
  shared through @dash: data, a jsPDF loader and the two settings calls are
  handed in. The loader is async so the PDF library is only fetched when someone
  actually downloads a statement.

  Two views of the same rows. By date is the chase list, oldest due date first.
  By customer is the statement run: one block per customer, biggest balance
  first, with a tick box per customer. Ticks survive switching between the two,
  because they select CUSTOMERS — a statement is per customer, not per invoice.

  A statement lists every item open on the date (credits too), not just the
  overdue invoices, unless "Overdue items only" is ticked. See openItems.js for
  why the tab and the statement answer different questions.
*/

const DEFAULT_PALETTE = {
  text: '#1e293b', strong: '#1E4560', muted: '#64748b', faint: '#94a3b8', border: '#e2e8f0',
  rowBorder: '#f1f5f9', accent: '#1E4560', accentText: '#ffffff', surface: '#ffffff',
  soft: '#f6f8f9', overdue: '#b91c1c', overdueSoft: '#fef2f2',
};

export default function OverdueInvoicesView({
  data, loading = false, error = null, onRetry,
  getJsPDF, loadSettings, saveSettings,
  palette = null, cardStyle = null,
}) {
  const p = { ...DEFAULT_PALETTE, ...(palette || {}) };
  const card = cardStyle || {
    background: p.surface, border: `1px solid ${p.border}`, borderRadius: 14, padding: '16px 18px', marginBottom: 12,
  };
  const currency = data?.currency || 'GBP';

  const [view, setView] = useState('date');
  const [selected, setSelected] = useState(() => new Set());
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [settings, setSettings] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // The letterhead, loaded up front so a download does not wait on it. The
  // loader is per client, so a new one means a new client: reload, and close
  // a settings form that was showing the last client's details.
  useEffect(() => {
    setSettings(null);
    setShowSettings(false);
    if (!loadSettings) return;
    let live = true;
    loadSettings().then((s) => { if (live) setSettings(s || null); }).catch(() => {});
    return () => { live = false; };
  }, [loadSettings]);

  // A new date or a new client is a new ledger: old ticks would point at
  // customers who may not be on it.
  useEffect(() => { setSelected(new Set()); setMsg(null); }, [data?.as_at, data]);

  const rows = useMemo(() => overdueInvoices(data), [data]);
  const byDate = useMemo(() => sortByDue(rows), [rows]);
  const groups = useMemo(() => groupByCustomer(rows), [rows]);
  const sum = useMemo(() => summarise(rows), [rows]);

  const toggle = (key) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });
  const allOn = groups.length > 0 && groups.every((g) => selected.has(g.key));
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(groups.map((g) => g.key)));

  const download = async () => {
    if (!getJsPDF || !selected.size) return;
    setBusy(true);
    setMsg(null);
    try {
      const statements = groups
        .filter((g) => selected.has(g.key))
        .map((g) => buildStatement(data, g.key, { overdueOnly }))
        .filter(Boolean);
      const jsPDF = await getJsPDF();
      await downloadStatements(jsPDF, statements, letterhead(settings, data?.business));
      setMsg({ bad: false, text: `${statements.length} statement${statements.length === 1 ? '' : 's'} downloaded.` });
    } catch (e) {
      setMsg({ bad: true, text: `Could not build the statements: ${e?.message || e}` });
    }
    setBusy(false);
  };

  const btn = (primary, disabled) => ({
    border: primary ? 'none' : `1px solid ${p.border}`, borderRadius: 9, padding: '8px 14px',
    fontSize: 14, fontWeight: 600, cursor: disabled ? 'default' : 'pointer',
    background: primary ? p.accent : p.surface, color: primary ? p.accentText : p.text,
    opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
  });
  const pill = (on) => ({
    border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13.5, cursor: 'pointer',
    background: on ? p.surface : 'transparent', color: on ? p.strong : p.muted,
    fontWeight: on ? 700 : 500, boxShadow: on ? '0 1px 2px rgba(15,23,42,0.08)' : 'none',
  });
  const th = (right) => ({
    textAlign: right ? 'right' : 'left', padding: '8px 10px', fontSize: 11.5, fontWeight: 700,
    color: p.faint, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: `1px solid ${p.border}`,
    whiteSpace: 'nowrap',
  });
  const td = (right, extra = {}) => ({
    textAlign: right ? 'right' : 'left', padding: '8px 10px', fontSize: 13.5, color: p.text,
    borderBottom: `1px solid ${p.rowBorder}`, whiteSpace: 'nowrap', ...extra,
  });
  const box = (key) => (
    <input
      type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)}
      aria-label="Select for statements" style={{ width: 16, height: 16, cursor: 'pointer', accentColor: p.accent }}
    />
  );
  const lateStyle = (d) => ({
    display: 'inline-block', minWidth: 34, textAlign: 'center', borderRadius: 999, padding: '1px 8px',
    fontSize: 12.5, fontWeight: 700,
    background: d > 60 ? p.overdueSoft : p.soft, color: d > 60 ? p.overdue : p.text,
  });

  if (error) {
    return (
      <div style={{ ...card, color: p.overdue }}>
        {error}{' '}
        {onRetry && <button onClick={onRetry} style={{ border: 'none', background: 'none', color: p.overdue, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>Try again</button>}
      </div>
    );
  }
  if (!data) {
    return <div style={{ ...card, color: p.faint, fontSize: 14 }}>{loading ? 'Fetching your invoices…' : 'No invoice data yet.'}</div>;
  }

  const Tile = ({ label, value, tone }) => (
    <div style={{ ...card, marginBottom: 0, padding: '12px 14px' }}>
      <div style={{ fontSize: 12, color: p.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone || p.strong, marginTop: 3 }}>{value}</div>
    </div>
  );

  return (
    <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 0.2s' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
        <Tile label="Overdue" value={money2(sum.total, currency)} tone={sum.total > 0 ? p.overdue : p.strong} />
        <Tile label="Invoices" value={sum.count} />
        <Tile label="Customers" value={sum.customers} />
        <Tile label="Over 60 days" value={money2(sum.over60, currency)} tone={sum.over60 > 0 ? p.overdue : p.strong} />
      </div>

      {showSettings && loadSettings && saveSettings && (
        <StatementSettingsForm
          load={loadSettings}
          save={async (s) => { const saved = await saveSettings(s); setSettings(saved); return saved; }}
          business={data.business}
          palette={p}
          onClose={() => setShowSettings(false)}
        />
      )}

      <div style={card}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'inline-flex', background: p.soft, borderRadius: 10, padding: 3 }}>
            <button style={pill(view === 'date')} onClick={() => setView('date')}>By date</button>
            <button style={pill(view === 'customer')} onClick={() => setView('customer')}>By customer</button>
          </div>
          <div style={{ fontSize: 13, color: p.muted }}>
            Unpaid on {dateGB(data.as_at)} and past their due date.
          </div>
          <div style={{ flex: 1 }} />
          {loadSettings && saveSettings && (
            <button style={btn(false)} onClick={() => setShowSettings((v) => !v)}>
              {settings?.logo_data_url ? 'Statement settings' : 'Add your logo'}
            </button>
          )}
        </div>

        {rows.length > 0 && (
          <div style={{
            display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px',
            background: p.soft, borderRadius: 10, marginBottom: 12,
          }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5, color: p.text, cursor: 'pointer' }}>
              <input type="checkbox" checked={allOn} onChange={toggleAll} style={{ width: 16, height: 16, accentColor: p.accent }} />
              All customers
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5, color: p.text, cursor: 'pointer' }}>
              <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} style={{ width: 16, height: 16, accentColor: p.accent }} />
              Overdue items only
            </label>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 13, color: p.muted }}>{selected.size} selected</span>
            <button style={btn(true, !selected.size || busy || !getJsPDF)} disabled={!selected.size || busy || !getJsPDF} onClick={download}>
              {busy ? 'Building…' : `Download statement${selected.size === 1 ? '' : 's'} (PDF)`}
            </button>
          </div>
        )}
        {msg && <div style={{ fontSize: 13.5, color: msg.bad ? p.overdue : '#047857', marginBottom: 10 }}>{msg.text}</div>}

        {rows.length === 0 ? (
          <div style={{ fontSize: 14.5, color: p.muted, padding: '18px 4px' }}>
            Nothing overdue on {dateGB(data.as_at)}. Every open invoice was within its terms.
          </div>
        ) : view === 'date' ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th(), width: 28 }} />
                  <th style={th()}>Due</th>
                  <th style={th(true)}>Days late</th>
                  <th style={th()}>Customer</th>
                  <th style={th()}>Invoice</th>
                  <th style={th()}>Issued</th>
                  <th style={th(true)}>Amount</th>
                  <th style={th(true)}>Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {byDate.map((r) => {
                  const key = r.customer_id || r.customer;
                  return (
                    <tr key={`${r.txn_id}-${r.number}`}>
                      <td style={td()}>{box(key)}</td>
                      <td style={td()}>{dateGB(r.due_date)}</td>
                      <td style={td(true)}><span style={lateStyle(r.days_overdue)}>{r.days_overdue}</span></td>
                      <td style={td(false, { whiteSpace: 'normal', minWidth: 160 })}>{r.customer}</td>
                      <td style={td()}>{r.number || '—'}</td>
                      <td style={td(false, { color: p.muted })}>{dateGB(r.date)}</td>
                      <td style={td(true, { color: p.muted })}>{money2(r.amount, currency)}</td>
                      <td style={td(true, { fontWeight: 700 })}>{money2(r.open, currency)}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={7} style={td(true, { fontWeight: 700, borderBottom: 'none' })}>Total overdue</td>
                  <td style={td(true, { fontWeight: 700, color: p.overdue, borderBottom: 'none' })}>{money2(sum.total, currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th(), width: 28 }} />
                  <th style={th()}>Invoice</th>
                  <th style={th()}>Issued</th>
                  <th style={th()}>Due</th>
                  <th style={th(true)}>Days late</th>
                  <th style={th(true)}>Amount</th>
                  <th style={th(true)}>Outstanding</th>
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.key}>
                  <tr style={{ background: p.soft }}>
                    <td style={td(false, { borderBottom: `1px solid ${p.border}` })}>{box(g.key)}</td>
                    <td colSpan={3} style={td(false, { fontWeight: 700, color: p.strong, whiteSpace: 'normal', borderBottom: `1px solid ${p.border}` })}>
                      {g.customer}
                      <span style={{ fontWeight: 500, color: p.muted, fontSize: 12.5 }}>
                        {' · '}{g.rows.length} invoice{g.rows.length === 1 ? '' : 's'}, oldest {g.oldest} days
                      </span>
                    </td>
                    <td style={td(false, { borderBottom: `1px solid ${p.border}` })} />
                    <td style={td(false, { borderBottom: `1px solid ${p.border}` })} />
                    <td style={td(true, { fontWeight: 700, color: p.overdue, borderBottom: `1px solid ${p.border}` })}>{money2(g.total, currency)}</td>
                  </tr>
                  {g.rows.map((r) => (
                    <tr key={`${r.txn_id}-${r.number}`}>
                      <td style={td()} />
                      <td style={td()}>{r.number || '—'}</td>
                      <td style={td(false, { color: p.muted })}>{dateGB(r.date)}</td>
                      <td style={td()}>{dateGB(r.due_date)}</td>
                      <td style={td(true)}><span style={lateStyle(r.days_overdue)}>{r.days_overdue}</span></td>
                      <td style={td(true, { color: p.muted })}>{money2(r.amount, currency)}</td>
                      <td style={td(true, { fontWeight: 700 })}>{money2(r.open, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
              <tbody>
                <tr>
                  <td colSpan={6} style={td(true, { fontWeight: 700, borderBottom: 'none' })}>Total overdue</td>
                  <td style={td(true, { fontWeight: 700, color: p.overdue, borderBottom: 'none' })}>{money2(sum.total, currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
