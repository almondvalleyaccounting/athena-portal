import React, { useState, useEffect } from 'react';
import { Bug, Plus, Download, Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open', color: '#f87171', bg: '#fef2f2' },
  { value: 'in_progress', label: 'In Progress', color: '#f59e0b', bg: '#fffbeb' },
  { value: 'closed', label: 'Closed', color: '#22c55e', bg: '#f0fdf4' },
];
const getStatusConfig = (status) => STATUS_OPTIONS.find((s) => s.value === status) || STATUS_OPTIONS[0];

export default function BugReportPage() {
  const { profile } = useAuth();
  const [bugs, setBugs] = useState([]);
  const [newBug, setNewBug] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [filterStatus, setFilterStatus] = useState('active'); // default: open + in_progress
  const [selected, setSelected] = useState(new Set());
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');

  useEffect(() => { loadBugs(); }, []);

  const loadBugs = async () => {
    try {
      const { data, error } = await supabase.from('bug_reports').select('*').order('created_at', { ascending: false });
      if (!error && data) setBugs(data);
    } catch { /* table may not exist */ }
    setLoading(false);
  };

  const handleSubmit = async () => {
    if (!newBug.trim() || submitting) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.from('bug_reports').insert({
        description: newBug.trim(),
        status: 'open',
        submitted_by: profile?.id,
        submitted_by_name: profile?.full_name || profile?.name || 'Unknown',
      });
      if (!error) { setNewBug(''); await loadBugs(); }
    } catch { /* silent */ }
    setSubmitting(false);
  };

  const handleStatusChange = async (bug, newStatus) => {
    try {
      await supabase.from('bug_reports').update({ status: newStatus }).eq('id', bug.id);
      setBugs((prev) => prev.map((b) => b.id === bug.id ? { ...b, status: newStatus } : b));
    } catch { /* silent */ }
  };

  const handleEdit = async (bug) => {
    if (!editText.trim() || editText.trim() === bug.description) { setEditingId(null); return; }
    try {
      await supabase.from('bug_reports').update({ description: editText.trim() }).eq('id', bug.id);
      setBugs((prev) => prev.map((b) => b.id === bug.id ? { ...b, description: editText.trim() } : b));
    } catch { /* silent */ }
    setEditingId(null);
  };

  const handleDelete = async (bug) => {
    if (!window.confirm(`Delete bug report "${bug.description.substring(0, 50)}..."?`)) return;
    // Check the DB result before touching local state — otherwise a blocked
    // delete looks successful until the next refetch brings the row back.
    const { error } = await supabase.from('bug_reports').delete().eq('id', bug.id);
    if (error) { window.alert(`Could not delete bug report: ${error.message}`); return; }
    setBugs((prev) => prev.filter((b) => b.id !== bug.id));
    setSelected((prev) => { const n = new Set(prev); n.delete(bug.id); return n; });
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} selected bug report(s)?`)) return;
    const failed = [];
    for (const id of selected) {
      const { error } = await supabase.from('bug_reports').delete().eq('id', id);
      if (error) failed.push(id);
    }
    // Keep only rows that genuinely failed to delete; drop the rest.
    setBugs((prev) => prev.filter((b) => !selected.has(b.id) || failed.includes(b.id)));
    setSelected(new Set(failed));
    if (failed.length) window.alert(`${failed.length} bug report(s) could not be deleted.`);
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === filteredBugs.length) setSelected(new Set());
    else setSelected(new Set(filteredBugs.map((b) => b.id)));
  };

  // Filter
  const filteredBugs = filterStatus === 'all' ? bugs
    : filterStatus === 'active' ? bugs.filter((b) => b.status === 'open' || b.status === 'in_progress')
    : bugs.filter((b) => b.status === filterStatus);

  const counts = {
    all: bugs.length,
    active: bugs.filter((b) => b.status === 'open' || b.status === 'in_progress').length,
    open: bugs.filter((b) => b.status === 'open').length,
    in_progress: bugs.filter((b) => b.status === 'in_progress').length,
    closed: bugs.filter((b) => b.status === 'closed').length,
  };

  // Export (selected only if any selected, else all filtered)
  const handleExport = () => {
    const toExport = selected.size > 0 ? filteredBugs.filter((b) => selected.has(b.id)) : filteredBugs;
    const headers = ['Description', 'Status', 'Submitted By', 'Date Added'];
    const rows = toExport.map((b) => [
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

  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: '40px 24px', fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', marginBottom: 8 }}>Bug Reports</h1>
          <p style={{ fontSize: 14, color: '#64748b' }}>Report issues, track their progress, and help us squash bugs faster.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {selected.size > 0 && (
            <button onClick={handleBulkDelete} style={{ ...btnOutline, color: '#dc2626', borderColor: '#fca5a5' }}>
              <Trash2 size={14} /> Delete ({selected.size})
            </button>
          )}
          {filteredBugs.length > 0 && (
            <button onClick={handleExport} style={btnOutline}>
              <Download size={14} /> Export{selected.size > 0 ? ` (${selected.size})` : ''}
            </button>
          )}
        </div>
      </div>

      {/* Submit */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <input value={newBug} onChange={(e) => setNewBug(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSubmit()} placeholder="Describe the bug..." disabled={submitting} style={inputStyle} onFocus={(e) => (e.target.style.borderColor = '#38bdf8')} onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')} />
        <button onClick={handleSubmit} disabled={!newBug.trim() || submitting} style={{ ...btnPrimary, opacity: (!newBug.trim() || submitting) ? 0.4 : 1 }}>
          <Plus size={16} /> Report
        </button>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 20, borderBottom: '1px solid #e5e7eb' }}>
        {[
          { value: 'active', label: 'Open & In Progress' },
          { value: 'all', label: 'All' },
          { value: 'open', label: 'Open' },
          { value: 'in_progress', label: 'In Progress' },
          { value: 'closed', label: 'Closed' },
        ].map((tab) => (
          <button key={tab.value} onClick={() => { setFilterStatus(tab.value); setSelected(new Set()); }} style={{
            fontSize: 12, fontWeight: filterStatus === tab.value ? 600 : 400,
            color: filterStatus === tab.value ? '#0f172a' : '#94a3b8',
            background: 'none', border: 'none',
            borderBottom: filterStatus === tab.value ? '2px solid #38bdf8' : '2px solid transparent',
            padding: '8px 14px', cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
          }}>
            {tab.label}
            <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 600, color: filterStatus === tab.value ? '#38bdf8' : '#cbd5e1' }}>{counts[tab.value]}</span>
          </button>
        ))}
      </div>

      {/* Bug list */}
      {loading ? (
        <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: 40 }}>Loading bug reports...</p>
      ) : filteredBugs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Bug size={36} style={{ color: '#e5e7eb', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 15, fontWeight: 500, color: '#94a3b8', marginBottom: 4 }}>
            {filterStatus === 'all' ? 'No bugs reported' : `No ${filterStatus === 'active' ? 'open or in progress' : filterStatus.replace('_', ' ')} bugs`}
          </p>
        </div>
      ) : (
        <div>
          {/* Select all */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '0 4px' }}>
            <input type="checkbox" checked={selected.size === filteredBugs.length && filteredBugs.length > 0} onChange={toggleSelectAll} style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#0e7fe0' }} />
            <span style={{ fontSize: 11, color: '#94a3b8' }}>Select all ({filteredBugs.length})</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filteredBugs.map((bug) => {
              const sc = getStatusConfig(bug.status);
              const isEditing = editingId === bug.id;
              return (
                <div key={bug.id} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                  backgroundColor: selected.has(bug.id) ? '#eff6ff' : '#fff',
                  borderRadius: 12, border: `1px solid ${selected.has(bug.id) ? '#0e7fe0' : '#e5e7eb'}`,
                  borderLeft: `3px solid ${sc.color}`, padding: '14px 16px',
                  transition: 'all 0.15s',
                }}>
                  {/* Checkbox */}
                  <input type="checkbox" checked={selected.has(bug.id)} onChange={() => toggleSelect(bug.id)} style={{ width: 14, height: 14, cursor: 'pointer', marginTop: 3, flexShrink: 0, accentColor: '#0e7fe0' }} />

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {isEditing ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                        <input value={editText} onChange={(e) => setEditText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleEdit(bug); if (e.key === 'Escape') setEditingId(null); }} autoFocus style={{ flex: 1, padding: '5px 10px', fontSize: 13, border: '1px solid #38bdf8', borderRadius: 8, outline: 'none', fontFamily: "'Outfit', sans-serif" }} />
                        <button onClick={() => handleEdit(bug)} style={{ fontSize: 12, fontWeight: 600, color: '#0e7fe0', background: 'none', border: 'none', cursor: 'pointer' }}>Save</button>
                        <button onClick={() => setEditingId(null)} style={{ fontSize: 12, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
                      </div>
                    ) : (
                      <p onClick={() => { setEditingId(bug.id); setEditText(bug.description); }} style={{
                        fontSize: 14, fontWeight: 500,
                        color: bug.status === 'closed' ? '#94a3b8' : '#0f172a',
                        lineHeight: 1.5, marginBottom: 6, cursor: 'pointer',
                        textDecoration: bug.status === 'closed' ? 'line-through' : 'none',
                      }} title="Click to edit">
                        {bug.description}
                      </p>
                    )}
                    <p style={{ fontSize: 12, color: '#94a3b8' }}>
                      {bug.submitted_by_name || 'Unknown'} &middot;{' '}
                      {new Date(bug.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  </div>

                  {/* Status + Delete */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    <select value={bug.status} onChange={(e) => handleStatusChange(bug, e.target.value)} style={{
                      fontSize: 11, fontWeight: 600, color: sc.color, backgroundColor: sc.bg,
                      border: 'none', borderRadius: 8, padding: '5px 8px', cursor: 'pointer', outline: 'none',
                    }}>
                      {STATUS_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                    <button onClick={() => handleDelete(bug)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#cbd5e1', transition: 'color 0.15s' }} onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'} onMouseLeave={(e) => e.currentTarget.style.color = '#cbd5e1'} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const btnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 6, backgroundColor: '#0f172a', color: '#fff', fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 10, padding: '12px 20px', cursor: 'pointer', transition: 'all 0.2s ease', flexShrink: 0 };
const btnOutline = { display: 'inline-flex', alignItems: 'center', gap: 5, backgroundColor: '#fff', color: '#0f172a', fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 600, border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 16px', cursor: 'pointer', transition: 'all 0.2s ease', flexShrink: 0 };
const inputStyle = { flex: 1, border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 16px', fontSize: 14, fontFamily: "'Outfit', sans-serif", outline: 'none', transition: 'border-color 0.2s ease' };
