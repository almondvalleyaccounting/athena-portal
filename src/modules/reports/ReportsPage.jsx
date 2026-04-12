import React, { useState } from 'react';
import { CheckSquare, Square, Play, ExternalLink, CheckCircle, AlertCircle, Loader } from 'lucide-react';

/* ─── Config ───────────────────────────────────────────────────── */
const CLIENTS = [
  { name: 'GB Cabins', realmId: '9130357945100516' },
  { name: 'Almond Valley Accounting', realmId: '123145912118784' },
];

const REPORTS = [
  { label: 'General Ledger', apiName: 'GeneralLedger', dateMode: 'range' },
  { label: 'Trial Balance', apiName: 'TrialBalance', dateMode: 'range' },
  { label: 'Profit & Loss', apiName: 'ProfitAndLoss', dateMode: 'range' },
  { label: 'Balance Sheet', apiName: 'BalanceSheet', dateMode: 'range' },
  { label: 'Aged Receivables', apiName: 'AgedReceivables', dateMode: 'single' },
  { label: 'Aged Payables', apiName: 'AgedPayables', dateMode: 'single' },
];

const WEBHOOK_URL = '/api/run-qbo-reports';

const DRIVE_FOLDER = 'https://drive.google.com/drive/folders/1rK_8c4RBysVsdGUSMgbcDD0z4Kr2DoW0';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function startOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/* ─── Reports page ─────────────────────────────────────────────── */
export default function ReportsPage() {
  const [client, setClient] = useState('');
  const [fromDate, setFromDate] = useState(startOfMonth());
  const [toDate, setToDate] = useState(todayStr());
  const [asAtDate, setAsAtDate] = useState(todayStr());
  const [basis, setBasis] = useState('Accrual');
  const [selected, setSelected] = useState({});
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState([]);

  const selectedClient = CLIENTS.find((c) => c.realmId === client);
  const selectedCount = Object.values(selected).filter(Boolean).length;
  const allSelected = selectedCount === REPORTS.length;
  const canRun = client && selectedCount > 0 && !running;

  const toggleReport = (apiName) => {
    setSelected((prev) => ({ ...prev, [apiName]: !prev[apiName] }));
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected({});
    } else {
      const all = {};
      REPORTS.forEach((r) => (all[r.apiName] = true));
      setSelected(all);
    }
  };

  const handleRun = async () => {
    const reportsToRun = REPORTS.filter((r) => selected[r.apiName]);
    if (!reportsToRun.length || !selectedClient) return;

    setRunning(true);
    setLog(reportsToRun.map((r) => ({ label: r.label, status: 'pending' })));

    for (let i = 0; i < reportsToRun.length; i++) {
      const report = reportsToRun[i];

      setLog((prev) =>
        prev.map((entry, j) =>
          j === i ? { ...entry, status: 'sending' } : entry
        )
      );

      const payload = {
        realm_id: selectedClient.realmId,
        report_type: report.apiName,
        client_name: selectedClient.name,
        start_date: report.dateMode === 'range' ? fromDate : '',
        end_date: report.dateMode === 'range' ? toDate : '',
        report_date: report.dateMode === 'single' ? asAtDate : '',
        accounting_method: basis,
      };

      try {
        const res = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        setLog((prev) =>
          prev.map((entry, j) =>
            j === i ? { ...entry, status: 'done' } : entry
          )
        );
      } catch (e) {
        setLog((prev) =>
          prev.map((entry, j) =>
            j === i ? { ...entry, status: 'error', message: e.message } : entry
          )
        );
      }
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
        <select
          value={client}
          onChange={(e) => setClient(e.target.value)}
          style={selectStyle}
        >
          <option value="">Select a client...</option>
          {CLIENTS.map((c) => (
            <option key={c.realmId} value={c.realmId}>
              {c.name}
            </option>
          ))}
        </select>

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
            const isChecked = !!selected[r.apiName];
            const Icon = isChecked ? CheckSquare : Square;

            return (
              <button
                key={r.apiName}
                onClick={() => toggleReport(r.apiName)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid',
                  borderColor: isChecked ? '#38bdf8' : '#e5e7eb',
                  backgroundColor: isChecked ? '#f0f9ff' : '#ffffff',
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
                  }}
                >
                  {r.label}
                </span>
                <span
                  style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: '11px',
                    color: '#94a3b8',
                  }}
                >
                  {r.dateMode === 'range' ? 'Date range' : 'As-at date'}
                </span>
              </button>
            );
          })}
        </div>

        {/* Run button */}
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
          {running ? 'Running...' : `Run Reports${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
        </button>
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
    sending: { label: 'Sending...', color: '#f59e0b', Icon: Loader },
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
