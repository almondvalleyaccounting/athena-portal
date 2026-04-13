import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckSquare, Square, Play, ExternalLink, CheckCircle, AlertCircle, Loader, FlaskConical, Plus, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getReportsAuthUrl } from '../../lib/qboApi';
import { useAuth } from '../../shell/AppShell';

/*
  Full 15-report list matching ControlPanel.gs REPORTS array.
  `name` matches the REPORTS[].name field in Apps Script.
  `dateMode`: range | point | prior_range
  `extraParam`: passed through to Apps Script for QBO query params
  `experimental`: may return 5020 on UK companies
  `defaultOn`: whether checked by default
*/
const REPORTS = [
  { name: 'GeneralLedger',        label: 'General Ledger',               dateMode: 'range',       defaultOn: true },
  { name: 'TrialBalance',         label: 'Trial Balance',                dateMode: 'range',       defaultOn: true },
  { name: 'ProfitAndLoss',        label: 'Profit & Loss',                dateMode: 'range',       defaultOn: true },
  { name: 'BalanceSheet',         label: 'Balance Sheet',                dateMode: 'range',       defaultOn: true },
  { name: 'AgedReceivables',      label: 'Aged Receivables',             dateMode: 'point',       defaultOn: true },
  { name: 'AgedPayables',         label: 'Aged Payables',                dateMode: 'point',       defaultOn: true },
  { name: 'AgedReceivableDetail', label: 'Aged Receivable Detail',       dateMode: 'point',       defaultOn: true },
  { name: 'AgedPayableDetail',    label: 'Aged Payable Detail',          dateMode: 'point',       defaultOn: true },
  { name: 'ProfitAndLossMonthly', label: 'Profit & Loss (Monthly)',      dateMode: 'range',       defaultOn: true,  extraParam: 'summarize_column_by=Month' },
  { name: 'TrialBalancePY',       label: 'Trial Balance (Prior Year)',   dateMode: 'prior_range', defaultOn: true },
  { name: 'ProfitAndLossMonthlyPY', label: 'P&L Monthly (Prior Year)',   dateMode: 'prior_range', defaultOn: true,  extraParam: 'summarize_column_by=Month' },
  { name: 'AgedReceivablesCurrent', label: 'Aged Receivables (Current)', dateMode: 'point',       defaultOn: true,  extraParam: 'aging_method=Current' },
  { name: 'AgedPayablesCurrent',  label: 'Aged Payables (Current)',      dateMode: 'point',       defaultOn: true,  extraParam: 'aging_method=Current' },
  { name: 'AccountList',          label: 'Account List',                 dateMode: 'range',       defaultOn: false, experimental: true },
  { name: 'ItemSales',            label: 'Sales by Product-Service',     dateMode: 'range',       defaultOn: false, experimental: true },
];

const API_URL = '/api/run-qbo-reports';

const DRIVE_FOLDER = 'https://drive.google.com/drive/folders/1rK_8c4RBysVsdGUSMgbcDD0z4Kr2DoW0';

/* ─── Date helpers ─────────────────────────────────────────────── */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function startOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Subtract one year from a YYYY-MM-DD string. Caps Feb 29 → Feb 28. */
function priorYear(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const py = y - 1;
  // Cap Feb 29 in leap year → Feb 28 in non-leap year
  const maxDay = new Date(py, m, 0).getDate(); // last day of month in prior year
  const safeDay = Math.min(d, maxDay);
  return `${py}-${String(m).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

/* ─── Reports page ─────────────────────────────────────────────── */
export default function ReportsPage() {
  const { profile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [client, setClient] = useState('');
  const [fromDate, setFromDate] = useState(startOfMonth());
  const [toDate, setToDate] = useState(todayStr());
  const [asAtDate, setAsAtDate] = useState(todayStr());
  const [basis, setBasis] = useState('Accrual');
  const [selected, setSelected] = useState(() => {
    const init = {};
    REPORTS.forEach((r) => { if (r.defaultOn) init[r.name] = true; });
    return init;
  });
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState([]);
  const [flash, setFlash] = useState(null);

  // Load connected clients from Supabase
  const loadClients = async () => {
    try {
      const { data, error } = await supabase
        .from('qbo_report_connections')
        .select('realm_id, company_name')
        .eq('status', 'active')
        .order('company_name');
      if (!error && data) setClients(data);
    } catch { /* silent */ }
    setClientsLoading(false);
  };

  useEffect(() => { loadClients(); }, []);

  // Handle OAuth return flash message
  useEffect(() => {
    const qbo = searchParams.get('qbo');
    if (qbo === 'connected') {
      setFlash({ type: 'success', message: 'Client connected successfully.' });
      loadClients(); // refresh the list
    } else if (qbo === 'error') {
      const msg = searchParams.get('message') || 'Connection failed.';
      setFlash({ type: 'error', message: msg });
    }
    if (qbo) {
      // Clear the params from URL without a navigation
      searchParams.delete('qbo');
      searchParams.delete('message');
      setSearchParams(searchParams, { replace: true });
    }
  }, []);

  const handleConnect = () => {
    window.location.href = getReportsAuthUrl(profile?.id || '');
  };

  const handleDisconnect = async (realmId) => {
    await supabase
      .from('qbo_report_connections')
      .update({ status: 'disconnected' })
      .eq('realm_id', realmId);
    setClients((prev) => prev.filter((c) => c.realm_id !== realmId));
    if (client === realmId) setClient('');
  };

  const selectedClient = clients.find((c) => c.realm_id === client);
  const selectedCount = Object.values(selected).filter(Boolean).length;
  const allSelected = selectedCount === REPORTS.length;
  const canRun = client && selectedCount > 0 && !running;

  const toggleReport = (name) => {
    setSelected((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected({});
    } else {
      const all = {};
      REPORTS.forEach((r) => (all[r.name] = true));
      setSelected(all);
    }
  };

  const handleRun = async () => {
    const reportsToRun = REPORTS.filter((r) => selected[r.name]);
    if (!reportsToRun.length || !selectedClient) return;

    setRunning(true);
    setLog(reportsToRun.map((r) => ({ label: r.label, status: 'pending' })));

    // Build the payload for Apps Script doPost
    // Send zero-based indices into the REPORTS array — unambiguous, no string matching
    const reportIndices = reportsToRun.map((r) => REPORTS.indexOf(r));

    const payload = {
      clientName: selectedClient.company_name,
      realmId: selectedClient.realm_id,
      startDate: fromDate,
      endDate: toDate,
      reportDate: asAtDate,
      accountingMethod: basis,
      reportIndices,
      outputFormat: 'excel',
    };

    // Single POST — Apps Script runs all selected reports
    setLog((prev) => prev.map((entry) => ({ ...entry, status: 'sending' })));

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.success === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // All done
      setLog((prev) => prev.map((entry) => ({ ...entry, status: 'done' })));
    } catch (e) {
      setLog((prev) => prev.map((entry) =>
        entry.status === 'sending' ? { ...entry, status: 'error', message: e.message } : entry
      ));
    }

    setRunning(false);
  };

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '40px 24px' }}>
      {/* Header */}
      <h1
        style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: '28px',
          fontWeight: 500,
          color: '#0f172a',
          marginBottom: '8px',
        }}
      >
        QBO Reports
      </h1>
      <p
        style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: '14px',
          color: '#64748b',
          marginBottom: '32px',
        }}
      >
        Extract reports from QuickBooks Online into the Shared Drive.
      </p>

      {/* ── Flash message ── */}
      {flash && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 14px',
            borderRadius: '10px',
            marginBottom: '16px',
            backgroundColor: flash.type === 'success' ? '#f0fdf4' : '#fef2f2',
            border: `1px solid ${flash.type === 'success' ? '#bbf7d0' : '#fecaca'}`,
          }}
        >
          {flash.type === 'success'
            ? <CheckCircle size={16} style={{ color: '#22c55e' }} />
            : <AlertCircle size={16} style={{ color: '#ef4444' }} />
          }
          <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: '13px', fontWeight: 500, color: flash.type === 'success' ? '#166534' : '#991b1b', flex: 1 }}>
            {flash.message}
          </span>
          <button onClick={() => setFlash(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>
            <X size={14} style={{ color: '#94a3b8' }} />
          </button>
        </div>
      )}

      {/* ── Form card ── */}
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          border: '1px solid #e5e7eb',
          padding: '24px',
          marginBottom: '24px',
        }}
      >
        {/* Client selector */}
        <label style={labelStyle}>Client</label>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
          <select
            value={client}
            onChange={(e) => setClient(e.target.value)}
            style={{ ...selectStyle, marginBottom: 0, flex: 1 }}
            disabled={clientsLoading}
          >
            <option value="">{clientsLoading ? 'Loading clients...' : 'Select a client...'}</option>
            {clients.map((c) => (
              <option key={c.realm_id} value={c.realm_id}>
                {c.company_name}
              </option>
            ))}
          </select>
          {/* Disconnect button — only when a client is selected */}
          {client && (
            <button
              onClick={() => handleDisconnect(client)}
              title="Remove this client"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '42px',
                border: '1px solid #fecaca',
                borderRadius: '10px',
                backgroundColor: '#ffffff',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#fef2f2'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#ffffff'; }}
            >
              <X size={16} style={{ color: '#ef4444' }} />
            </button>
          )}
          {/* Connect new client button */}
          <button
            onClick={handleConnect}
            title="Connect a new QBO client"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '0 16px',
              border: '1px solid #e5e7eb',
              borderRadius: '10px',
              backgroundColor: '#ffffff',
              cursor: 'pointer',
              fontFamily: "'Outfit', sans-serif",
              fontSize: '13px',
              fontWeight: 600,
              color: '#38bdf8',
              transition: 'all 0.2s ease',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f0f9ff'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#ffffff'; }}
          >
            <Plus size={14} />
            Connect
          </button>
        </div>

        {/* Date inputs row */}
        <div style={{ display: 'flex', gap: '16px', marginBottom: '20px' }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>From date</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>To date</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>As-at date</label>
            <input
              type="date"
              value={asAtDate}
              onChange={(e) => setAsAtDate(e.target.value)}
              style={inputStyle}
            />
          </div>
        </div>

        {/* Prior year info */}
        {Object.keys(selected).some((name) => {
          const r = REPORTS.find((rr) => rr.name === name);
          return r && r.dateMode === 'prior_range' && selected[name];
        }) && (
          <p
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '12px',
              color: '#94a3b8',
              marginBottom: '16px',
              padding: '8px 12px',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px solid #f1f5f9',
            }}
          >
            Prior year reports will use {priorYear(fromDate)} to {priorYear(toDate)}
          </p>
        )}

        {/* Accounting basis toggle */}
        <label style={labelStyle}>Accounting basis</label>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
          {['Accrual', 'Cash'].map((opt) => (
            <button
              key={opt}
              onClick={() => setBasis(opt)}
              style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: '13px',
                fontWeight: 600,
                padding: '8px 20px',
                borderRadius: '10px',
                border: '1px solid',
                borderColor: basis === opt ? '#38bdf8' : '#e5e7eb',
                backgroundColor: basis === opt ? '#f0f9ff' : '#ffffff',
                color: basis === opt ? '#0f172a' : '#64748b',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              {opt}
            </button>
          ))}
        </div>

        {/* Separator */}
        <div style={{ height: '1px', backgroundColor: '#f1f5f9', marginBottom: '20px' }} />

        {/* Report checkboxes */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>Reports</label>
          <button
            onClick={toggleAll}
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '12px',
              fontWeight: 600,
              color: '#38bdf8',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '24px' }}>
          {REPORTS.map((r) => {
            const isChecked = !!selected[r.name];
            const Icon = isChecked ? CheckSquare : Square;
            const dateModeLabel =
              r.dateMode === 'range' ? 'Date range' :
              r.dateMode === 'point' ? 'As-at date' :
              'Prior year';

            return (
              <button
                key={r.name}
                onClick={() => toggleReport(r.name)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid',
                  borderColor: isChecked ? '#38bdf8' : r.experimental ? '#fef3c7' : '#e5e7eb',
                  backgroundColor: isChecked ? '#f0f9ff' : r.experimental ? '#fffbeb' : '#ffffff',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  width: '100%',
                  textAlign: 'left',
                }}
              >
                <Icon
                  size={18}
                  style={{ color: isChecked ? '#38bdf8' : '#cbd5e1', flexShrink: 0 }}
                />
                <span
                  style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: '14px',
                    fontWeight: 500,
                    color: '#0f172a',
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  {r.label}
                  {r.experimental && (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '3px',
                        fontFamily: "'Outfit', sans-serif",
                        fontSize: '10px',
                        fontWeight: 600,
                        color: '#d97706',
                        backgroundColor: '#fef3c7',
                        padding: '1px 6px',
                        borderRadius: '8px',
                      }}
                    >
                      <FlaskConical size={10} />
                      Experimental
                    </span>
                  )}
                </span>
                <span
                  style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: '11px',
                    color: '#94a3b8',
                    flexShrink: 0,
                  }}
                >
                  {dateModeLabel}
                </span>
              </button>
            );
          })}
        </div>

        {/* Run button / running indicator */}
        {running ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              width: '100%',
              padding: '14px',
              borderRadius: '10px',
              backgroundColor: '#f0f9ff',
              border: '1px solid #bae6fd',
            }}
          >
            <span
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                backgroundColor: '#38bdf8',
                animation: 'pulse-dot 1.4s ease-in-out infinite',
              }}
            />
            <span
              style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: '14px',
                fontWeight: 600,
                color: '#0369a1',
              }}
            >
              Running reports…
            </span>
            <style>{`@keyframes pulse-dot { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.7); } }`}</style>
          </div>
        ) : (
          <button
            onClick={handleRun}
            disabled={!canRun}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              width: '100%',
              backgroundColor: canRun ? '#38bdf8' : '#e5e7eb',
              color: canRun ? '#ffffff' : '#94a3b8',
              fontFamily: "'Outfit', sans-serif",
              fontSize: '14px',
              fontWeight: 600,
              borderRadius: '10px',
              padding: '14px',
              border: 'none',
              cursor: canRun ? 'pointer' : 'not-allowed',
              transition: 'all 0.2s ease',
            }}
          >
            <Play size={16} />
            Run Reports
          </button>
        )}
      </div>

      {/* ── Run log ── */}
      {log.length > 0 && (
        <div
          style={{
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            border: '1px solid #e5e7eb',
            padding: '20px 24px',
            marginBottom: '24px',
          }}
        >
          <label style={{ ...labelStyle, marginBottom: '12px' }}>Run log</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {log.map((entry, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: i < log.length - 1 ? '1px solid #f1f5f9' : 'none',
                }}
              >
                <span
                  style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: '14px',
                    fontWeight: 500,
                    color: '#0f172a',
                  }}
                >
                  {entry.label}
                </span>
                <StatusBadge status={entry.status} message={entry.message} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Shared Drive link ── */}
      <a
        href={DRIVE_FOLDER}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          fontFamily: "'Outfit', sans-serif",
          fontSize: '13px',
          fontWeight: 500,
          color: '#38bdf8',
          textDecoration: 'none',
        }}
      >
        View output folder <ExternalLink size={13} />
      </a>
    </div>
  );
}

/* ─── Status badge ─────────────────────────────────────────────── */
function StatusBadge({ status, message }) {
  const configs = {
    pending: { label: 'Pending', color: '#94a3b8', Icon: null },
    sending: { label: 'Running...', color: '#f59e0b', Icon: Loader },
    done: { label: 'Done', color: '#22c55e', Icon: CheckCircle },
    error: { label: message || 'Error', color: '#ef4444', Icon: AlertCircle },
  };

  const cfg = configs[status] || configs.pending;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontFamily: "'Outfit', sans-serif",
        fontSize: '12px',
        fontWeight: 600,
        color: cfg.color,
      }}
    >
      {cfg.Icon && (
        <cfg.Icon
          size={14}
          style={status === 'sending' ? { animation: 'spin 1s linear infinite' } : {}}
        />
      )}
      {cfg.label}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

/* ─── Shared styles ────────────────────────────────────────────── */
const labelStyle = {
  display: 'block',
  fontFamily: "'Outfit', sans-serif",
  fontSize: '12px',
  fontWeight: 600,
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
  marginBottom: '8px',
};

const inputStyle = {
  width: '100%',
  border: '1px solid #e5e7eb',
  borderRadius: '10px',
  padding: '10px 14px',
  fontSize: '14px',
  fontFamily: "'Outfit', sans-serif",
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.2s ease',
};

const selectStyle = {
  ...inputStyle,
  marginBottom: '20px',
  appearance: 'auto',
};
