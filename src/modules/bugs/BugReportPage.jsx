import React, { useState, useEffect } from 'react';
import { Bug, Plus, Download, Circle, Clock, CheckCircle2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';

/* ─── Status config ───────────────────────────────────────────── */
const STATUS_OPTIONS = [
  { value: 'open', label: 'Open', color: '#f87171', bg: '#fef2f2', icon: Circle },
  { value: 'in_progress', label: 'In Progress', color: '#f59e0b', bg: '#fffbeb', icon: Clock },
  { value: 'closed', label: 'Closed', color: '#22c55e', bg: '#f0fdf4', icon: CheckCircle2 },
];

const getStatusConfig = (status) =>
  STATUS_OPTIONS.find((s) => s.value === status) || STATUS_OPTIONS[0];

/* ─── Bug Reports module ──────────────────────────────────────── */
export default function BugReportPage() {
  const { profile } = useAuth();
  const [bugs, setBugs] = useState([]);
  const [newBug, setNewBug] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [filterStatus, setFilterStatus] = useState('all');

  // ── Load bugs ──
  useEffect(() => {
    loadBugs();
  }, []);

  const loadBugs = async () => {
    try {
      const { data, error } = await supabase
        .from('bug_reports')
        .select('*')
        .order('created_at', { ascending: false });

      if (!error && data) {
        setBugs(data);
      }
    } catch {
      // Silently fail — table may not exist yet
    }
    setLoading(false);
  };

  // ── Submit new bug ──
  const handleSubmit = async () => {
    if (!newBug.trim() || submitting) return;
    setSubmitting(true);

    try {
      const { error } = await supabase.from('bug_reports').insert({
        description: newBug.trim(),
        status: 'open',
        submitted_by: profile?.id,
        submitted_by_name: profile?.full_name || 'Unknown',
      });

      if (!error) {
        setNewBug('');
        await loadBugs();
      }
    } catch {
      // Silent
    }
    setSubmitting(false);
  };

  // ── Update status ──
  const handleStatusChange = async (bug, newStatus) => {
    try {
      const { error } = await supabase
        .from('bug_reports')
        .update({ status: newStatus })
        .eq('id', bug.id);

      if (!error) {
        setBugs((prev) =>
          prev.map((b) => (b.id === bug.id ? { ...b, status: newStatus } : b))
        );
      }
    } catch {
      // Silent
    }
  };

  // ── Export to CSV ──
  const handleExport = () => {
    const filtered = filterStatus === 'all' ? bugs : bugs.filter((b) => b.status === filterStatus);
    const headers = ['Description', 'Status', 'Submitted By', 'Date'];
    const rows = filtered.map((b) => [
      `"${(b.description || '').replace(/"/g, '""')}"`,
      getStatusConfig(b.status).label,
      b.submitted_by_name || 'Unknown',
      new Date(b.created_at).toLocaleDateString('en-GB'),
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bug-reports-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ── Filtered list ──
  const filteredBugs =
    filterStatus === 'all' ? bugs : bugs.filter((b) => b.status === filterStatus);

  // ── Counts ──
  const counts = {
    all: bugs.length,
    open: bugs.filter((b) => b.status === 'open').length,
    in_progress: bugs.filter((b) => b.status === 'in_progress').length,
    closed: bugs.filter((b) => b.status === 'closed').length,
  };

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '40px 24px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px' }}>
        <div>
          <h1
            style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: '28px',
              fontWeight: 500,
              color: '#0f172a',
              marginBottom: '8px',
            }}
          >
            Bug Reports
          </h1>
          <p
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '14px',
              color: '#64748b',
            }}
          >
            Report issues, track their progress, and help us squash bugs faster.
          </p>
        </div>
        {bugs.length > 0 && (
          <button
            onClick={handleExport}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              backgroundColor: '#ffffff',
              color: '#0f172a',
              fontFamily: "'Outfit', sans-serif",
              fontSize: '13px',
              fontWeight: 600,
              border: '1px solid #e5e7eb',
              borderRadius: '10px',
              padding: '10px 16px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = '#38bdf8';
              e.currentTarget.style.color = '#38bdf8';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = '#e5e7eb';
              e.currentTarget.style.color = '#0f172a';
            }}
            title="Export as CSV"
          >
            <Download size={15} />
            Export
          </button>
        )}
      </div>

      {/* Submit new bug */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
          marginBottom: '24px',
        }}
      >
        <input
          value={newBug}
          onChange={(e) => setNewBug(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Describe the bug..."
          disabled={submitting}
          style={{
            flex: 1,
            border: '1px solid #e5e7eb',
            borderRadius: '10px',
            padding: '12px 16px',
            fontSize: '14px',
            fontFamily: "'Outfit', sans-serif",
            outline: 'none',
            transition: 'border-color 0.2s ease',
          }}
          onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
          onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
        />
        <button
          onClick={handleSubmit}
          disabled={!newBug.trim() || submitting}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: !newBug.trim() || submitting ? '#e5e7eb' : '#0f172a',
            color: !newBug.trim() || submitting ? '#94a3b8' : '#ffffff',
            fontFamily: "'Outfit', sans-serif",
            fontSize: '13px',
            fontWeight: 600,
            border: 'none',
            borderRadius: '10px',
            padding: '12px 20px',
            cursor: !newBug.trim() || submitting ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s ease',
            flexShrink: 0,
          }}
        >
          <Plus size={16} />
          Report
        </button>
      </div>

      {/* Filter tabs */}
      <div
        style={{
          display: 'flex',
          gap: '4px',
          marginBottom: '20px',
          borderBottom: '1px solid #e5e7eb',
          paddingBottom: '0',
        }}
      >
        {[
          { value: 'all', label: 'All' },
          { value: 'open', label: 'Open' },
          { value: 'in_progress', label: 'In Progress' },
          { value: 'closed', label: 'Closed' },
        ].map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilterStatus(tab.value)}
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '13px',
              fontWeight: filterStatus === tab.value ? 600 : 400,
              color: filterStatus === tab.value ? '#0f172a' : '#94a3b8',
              background: 'none',
              border: 'none',
              borderBottom: filterStatus === tab.value ? '2px solid #38bdf8' : '2px solid transparent',
              padding: '8px 16px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            {tab.label}
            <span
              style={{
                marginLeft: '6px',
                fontSize: '11px',
                fontWeight: 600,
                color: filterStatus === tab.value ? '#38bdf8' : '#cbd5e1',
              }}
            >
              {counts[tab.value]}
            </span>
          </button>
        ))}
      </div>

      {/* Bug list */}
      {loading ? (
        <p
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '13px',
            color: '#94a3b8',
            textAlign: 'center',
            padding: '40px 0',
          }}
        >
          Loading bug reports...
        </p>
      ) : filteredBugs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <Bug
            size={36}
            style={{ color: '#e5e7eb', marginBottom: '16px', margin: '0 auto 16px' }}
          />
          <p
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '15px',
              fontWeight: 500,
              color: '#94a3b8',
              marginBottom: '4px',
            }}
          >
            {filterStatus === 'all' ? 'No bugs reported' : `No ${filterStatus.replace('_', ' ')} bugs`}
          </p>
          <p
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '13px',
              color: '#cbd5e1',
            }}
          >
            {filterStatus === 'all'
              ? 'Report a bug to get started.'
              : 'Try a different filter.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filteredBugs.map((bug) => {
            const sc = getStatusConfig(bug.status);
            return (
              <div
                key={bug.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '16px',
                  backgroundColor: '#ffffff',
                  borderRadius: '12px',
                  border: '1px solid #e5e7eb',
                  borderLeft: `3px solid ${sc.color}`,
                  padding: '16px 20px',
                  transition: 'all 0.2s ease',
                }}
              >
                {/* Bug content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p
                    style={{
                      fontFamily: "'Outfit', sans-serif",
                      fontSize: '14px',
                      fontWeight: 500,
                      color: bug.status === 'closed' ? '#94a3b8' : '#0f172a',
                      lineHeight: '1.5',
                      marginBottom: '6px',
                      textDecoration: bug.status === 'closed' ? 'line-through' : 'none',
                    }}
                  >
                    {bug.description}
                  </p>
                  <p
                    style={{
                      fontFamily: "'Outfit', sans-serif",
                      fontSize: '12px',
                      color: '#94a3b8',
                    }}
                  >
                    {bug.submitted_by_name || 'Unknown'} &middot;{' '}
                    {new Date(bug.created_at).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </p>
                </div>

                {/* Status dropdown */}
                <select
                  value={bug.status}
                  onChange={(e) => handleStatusChange(bug, e.target.value)}
                  style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: '12px',
                    fontWeight: 600,
                    color: sc.color,
                    backgroundColor: sc.bg,
                    border: 'none',
                    borderRadius: '8px',
                    padding: '6px 10px',
                    cursor: 'pointer',
                    outline: 'none',
                    flexShrink: 0,
                    appearance: 'auto',
                  }}
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
