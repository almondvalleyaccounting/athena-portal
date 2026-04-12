import React, { useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { CLIENT_OPTIONS, REPORTS } from './reportConstants';

function prevMonthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const fmt = (d) => d.toISOString().split('T')[0];
  return { start: fmt(first), end: fmt(last) };
}

const inputStyle = {
  border: '1px solid #e5e7eb',
  borderRadius: '10px',
  padding: '12px 16px',
  fontSize: '14px',
  fontFamily: 'Outfit, sans-serif',
  width: '100%',
};

export default function ReportForm({ onSuccess }) {
  const { start, end } = prevMonthRange();
  const [client, setClient] = useState('');
  const [selected, setSelected] = useState([]);
  const [dateFrom, setDateFrom] = useState(start);
  const [dateTo, setDateTo] = useState(end);
  const [reportDate, setReportDate] = useState(end);
  const [basis, setBasis] = useState('Accrual');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [banner, setBanner] = useState(null);

  const toggle = (id) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const selectedTypes = useMemo(() => {
    const types = new Set(selected.map((id) => REPORTS.find((r) => r.id === id)?.type));
    return types;
  }, [selected]);

  const showRange = selectedTypes.has('range');
  const showPoint = selectedTypes.has('point');
  const showDates = showRange || showPoint;
  const onlyNone = selected.length > 0 && !showRange && !showPoint;

  const canRun = client && selected.length > 0 && !running;

  const handleRun = async () => {
    setRunning(true);
    setBanner(null);

    const clientObj = CLIENT_OPTIONS.find((c) => c.label === client);
    const total = selected.length;
    let errorMsg = null;

    for (let i = 0; i < total; i++) {
      const report = REPORTS.find((r) => r.id === selected[i]);
      setProgress(`Running ${i + 1} of ${total}…`);

      try {
        const { data: { session } } = await supabase.auth.getSession();
        const resp = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trigger-report`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              client_name: client,
              realm_id: clientObj.realmId,
              report_type: report.id,
              report_label: report.label,
              start_date: report.type === 'range' ? dateFrom : '',
              end_date: report.type === 'range' ? dateTo : '',
              report_date: report.type === 'point' ? reportDate : '',
              accounting_method: basis,
            }),
          }
        );

        const result = await resp.json();
        if (!result.success) {
          errorMsg = result.error || 'Unknown error';
          break;
        }
      } catch (err) {
        errorMsg = String(err);
        break;
      }
    }

    setRunning(false);
    setProgress('');

    if (errorMsg) {
      setBanner({ type: 'error', message: errorMsg });
    } else {
      setBanner({ type: 'success', message: 'Reports dispatched. Outputs will appear in Google Drive.' });
      setSelected([]);
      onSuccess?.();
      setTimeout(() => setBanner((b) => b?.type === 'success' ? null : b), 4000);
    }
  };

  const rangeReports = REPORTS.filter((r) => r.type === 'range');
  const pointReports = REPORTS.filter((r) => r.type === 'point');
  const noneReports = REPORTS.filter((r) => r.type === 'none');

  return (
    <div className="flex flex-col gap-6">
      {/* Banner */}
      {banner && (
        <div
          className={`rounded-lg px-4 py-3 text-sm font-medium flex items-center justify-between ${
            banner.type === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          <span>{banner.message}</span>
          {banner.type === 'error' && (
            <button onClick={() => setBanner(null)} className="ml-3 text-red-400 hover:text-red-600">✕</button>
          )}
        </div>
      )}

      {/* Client selector */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">Client</label>
        <select value={client} onChange={(e) => setClient(e.target.value)} style={inputStyle} disabled={running}>
          <option value="">Select client…</option>
          {CLIENT_OPTIONS.map((c) => (
            <option key={c.realmId} value={c.label}>{c.label}</option>
          ))}
        </select>
      </div>

      {/* Report checkboxes */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Reports</label>

        <p className="text-xs font-semibold text-gray-500 uppercase mb-1.5" style={{ letterSpacing: '0.04em' }}>
          Date range reports
        </p>
        <div className="flex flex-col gap-1 mb-4">
          {rangeReports.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                onChange={() => toggle(r.id)}
                disabled={running}
                className="accent-slate-800"
              />
              {r.label}
            </label>
          ))}
        </div>

        <p className="text-xs font-semibold text-gray-500 uppercase mb-1.5" style={{ letterSpacing: '0.04em' }}>
          Point-in-time reports
        </p>
        <div className="flex flex-col gap-1 mb-4">
          {pointReports.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                onChange={() => toggle(r.id)}
                disabled={running}
                className="accent-slate-800"
              />
              {r.label}
            </label>
          ))}
        </div>

        <p className="text-xs font-semibold text-gray-500 uppercase mb-1.5" style={{ letterSpacing: '0.04em' }}>
          Other
        </p>
        <div className="flex flex-col gap-1">
          {noneReports.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                onChange={() => toggle(r.id)}
                disabled={running}
                className="accent-slate-800"
              />
              {r.label}
              <span className="text-xs text-gray-400">(no dates required)</span>
            </label>
          ))}
        </div>
      </div>

      {/* Date inputs — conditional */}
      {showDates && !onlyNone && (
        <div className="flex flex-col gap-4">
          {showRange && (
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Date from</label>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={inputStyle} disabled={running} />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Date to</label>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputStyle} disabled={running} />
              </div>
            </div>
          )}
          {showPoint && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Report date</label>
              <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} style={inputStyle} disabled={running} />
            </div>
          )}
        </div>
      )}

      {/* Accounting basis */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">Accounting basis</label>
        <div className="flex gap-4">
          {['Accrual', 'Cash'].map((b) => (
            <label key={b} className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
              <input
                type="radio"
                name="basis"
                value={b}
                checked={basis === b}
                onChange={() => setBasis(b)}
                disabled={running}
                className="accent-slate-800"
              />
              {b}
            </label>
          ))}
        </div>
      </div>

      {/* Run button */}
      <button
        onClick={handleRun}
        disabled={!canRun}
        className="w-full text-white font-semibold text-sm transition-opacity"
        style={{
          background: '#0f172a',
          borderRadius: '10px',
          padding: '14px',
          opacity: canRun ? 1 : 0.5,
          cursor: canRun ? 'pointer' : 'not-allowed',
        }}
      >
        {running
          ? progress || 'Running…'
          : `Run ${selected.length || 0} report${selected.length === 1 ? '' : 's'}`}
      </button>
    </div>
  );
}
