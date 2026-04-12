import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { DRIVE_FOLDER_URL } from './reportConstants';

const STATUS_STYLES = {
  triggered: { bg: '#fbbf2415', text: '#d97706' },
  complete:  { bg: '#38bdf815', text: '#38bdf8' },
  failed:    { bg: '#f8717115', text: '#ef4444' },
};

function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.triggered;
  return (
    <span
      className="text-xs font-medium px-2 py-0.5 rounded-full capitalize"
      style={{ backgroundColor: s.bg, color: s.text }}
    >
      {status}
    </span>
  );
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return (
    d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  );
}

export default function RunLog({ refreshKey }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('report_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(25);
    setRuns(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { fetchRuns(); }, [fetchRuns, refreshKey]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase text-gray-400" style={{ letterSpacing: '0.08em' }}>
          Recent runs
        </h3>
        <button
          onClick={fetchRuns}
          className="text-xs text-blue-500 hover:text-blue-700"
        >
          Refresh ↻
        </button>
      </div>

      <p className="text-xs text-gray-400 italic mb-4">
        Reports are dispatched to QuickBooks and written to Google Drive.
        Status shows dispatch only — not completion.
      </p>

      {loading ? (
        <p className="text-sm text-gray-400 text-center py-6">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">No reports run yet.</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {runs.map((r) => {
            const dateRange =
              r.start_date && r.end_date
                ? `${formatDate(r.start_date)} – ${formatDate(r.end_date)}`
                : r.report_date
                ? formatDate(r.report_date)
                : null;

            return (
              <div
                key={r.id}
                className="border border-gray-200 rounded-xl p-4"
                style={{ padding: '16px 20px' }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-800">
                    {r.report_label} — {r.client_name}
                  </span>
                  <StatusBadge status={r.status} />
                </div>
                <p className="text-xs text-gray-400">
                  {[dateRange, r.accounting_method].filter(Boolean).join(' · ')}
                </p>
                <p className="text-xs text-gray-400">
                  {r.user_name || r.user_email} · {formatTimestamp(r.created_at)}
                </p>
              </div>
            );
          })}
        </div>
      )}

      <a
        href={DRIVE_FOLDER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="block mt-4 text-sm font-medium hover:underline"
        style={{ color: '#38bdf8' }}
      >
        Open Reports folder in Google Drive →
      </a>
    </div>
  );
}
