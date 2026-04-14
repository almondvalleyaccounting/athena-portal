import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Download, AlertTriangle, Clock, CheckCircle2, Filter } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';

/* ─── Issues Log Module ───────────────────────────────────── */

const STATUSES = [
  { id: 'open', label: 'Open', colour: '#dc2626', bg: '#fef2f2' },
  { id: 'investigating', label: 'Investigating', colour: '#d97706', bg: '#fffbeb' },
  { id: 'in_progress', label: 'In Progress', colour: '#0e7fe0', bg: '#eff6ff' },
  { id: 'awaiting_response', label: 'Awaiting Response', colour: '#7c3aed', bg: '#f5f3ff' },
  { id: 'resolved', label: 'Resolved', colour: '#059669', bg: '#f0fdf4' },
  { id: 'closed', label: 'Closed', colour: '#64748b', bg: '#f1f5f9' },
];

const PRIORITIES = [
  { id: 'critical', label: 'Critical', colour: '#dc2626', icon: '🔴' },
  { id: 'high', label: 'High', colour: '#ea580c', icon: '🟠' },
  { id: 'medium', label: 'Medium', colour: '#d97706', icon: '🟡' },
  { id: 'low', label: 'Low', colour: '#059669', icon: '🟢' },
];

const CATEGORIES = [
  'Software', 'Process', 'Client', 'Infrastructure', 'Compliance', 'Training', 'Other',
];

function daysSince(dateStr) {
  if (!dateStr) return 0;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / 86400000);
}

function ageBadge(days) {
  if (days <= 1) return { text: 'Today', bg: '#f0fdf4', colour: '#059669' };
  if (days <= 3) return { text: `${days}d`, bg: '#eff6ff', colour: '#0e7fe0' };
  if (days <= 7) return { text: `${days}d`, bg: '#fffbeb', colour: '#d97706' };
  return { text: `${days}d`, bg: '#fef2f2', colour: '#dc2626' };
}

export default function IssuesPage() {
  const { profile } = useAuth();
  const [issues, setIssues] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('active'); // 'active' | 'all' | specific status
  const [filterPriority, setFilterPriority] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  // New issue form
  const [formTitle, setFormTitle] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formPriority, setFormPriority] = useState('medium');
  const [formCategory, setFormCategory] = useState('Other');
  const [formAssignee, setFormAssignee] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [{ data: iss }, { data: staff }] = await Promise.all([
        supabase.from('issues_log').select('*').order('created_at', { ascending: false }),
        supabase.from('staff_profiles').select('id, full_name, name, email').eq('is_active', true).order('full_name'),
      ]);
      setIssues(iss || []);
      setStaffList((staff || []).map((s) => ({ ...s, name: s.full_name || s.name || s.email })));
    } catch (e) {
      console.error('[Issues] load error:', e);
      try { const { data: staff } = await supabase.from('staff_profiles').select('id, full_name, name, email').eq('is_active', true); setStaffList((staff || []).map((s) => ({ ...s, name: s.full_name || s.name || s.email }))); } catch {}
    }
    setLoading(false);
  };

  const staffMap = useMemo(() => { const m = {}; staffList.forEach((s) => { m[s.id] = s; }); return m; }, [staffList]);

  const filtered = useMemo(() => {
    let list = [...issues];
    if (filterStatus === 'active') list = list.filter((i) => !['resolved', 'closed'].includes(i.status));
    else if (filterStatus !== 'all') list = list.filter((i) => i.status === filterStatus);
    if (filterPriority) list = list.filter((i) => i.priority === filterPriority);
    return list;
  }, [issues, filterStatus, filterPriority]);

  const counts = useMemo(() => {
    const c = { all: issues.length, active: issues.filter((i) => !['resolved', 'closed'].includes(i.status)).length };
    STATUSES.forEach((s) => { c[s.id] = issues.filter((i) => i.status === s.id).length; });
    return c;
  }, [issues]);

  const handleAdd = async () => {
    if (!formTitle.trim()) return;
    setSaving(true);
    try {
      const { error } = await supabase.from('issues_log').insert({
        title: formTitle.trim(),
        description: formDesc.trim() || null,
        priority: formPriority,
        category: formCategory,
        status: 'open',
        reported_by: profile?.id,
        reported_by_name: profile?.full_name || profile?.name || 'Unknown',
        assignee_id: formAssignee || null,
      });
      if (!error) {
        setFormTitle(''); setFormDesc(''); setFormPriority('medium'); setFormCategory('Other'); setFormAssignee('');
        setShowAdd(false);
        await loadData();
      }
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const handleUpdate = async (id, patch) => {
    try {
      const update = { ...patch };
      if (patch.status === 'resolved') update.resolved_at = new Date().toISOString();
      if (patch.status === 'closed') update.closed_at = new Date().toISOString();
      await supabase.from('issues_log').update(update).eq('id', id);
      setIssues((prev) => prev.map((i) => i.id === id ? { ...i, ...update } : i));
    } catch (e) { console.error(e); }
  };

  const handleExport = () => {
    const headers = ['Title', 'Priority', 'Category', 'Status', 'Assignee', 'Age (days)', 'Reported By', 'Date'];
    const rows = filtered.map((i) => [
      `"${(i.title || '').replace(/"/g, '""')}"`,
      i.priority, i.category, i.status,
      `"${(staffMap[i.assignee_id]?.name || 'Unassigned').replace(/"/g, '""')}"`,
      daysSince(i.created_at),
      `"${(i.reported_by_name || '').replace(/"/g, '""')}"`,
      new Date(i.created_at).toLocaleDateString('en-GB'),
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `issues-log-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '32px 24px', fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 4 }}>Issues Log</h1>
          <p style={{ fontSize: 13, color: '#64748b' }}>
            {counts.active} active · {counts.all} total
            {counts.critical > 0 && <span style={{ color: '#dc2626', fontWeight: 600 }}> · {counts.critical} critical</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {filtered.length > 0 && <button onClick={handleExport} style={{ ...btnOutline, gap: 5 }}><Download size={14} /> Export</button>}
          <button onClick={() => setShowAdd(!showAdd)} style={{ ...btnPrimary }}><Plus size={14} /> Log Issue</button>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={formLabel}>Title *</label>
              <input value={formTitle} onChange={(e) => setFormTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }} placeholder="Brief summary of the issue..." style={inputStyle} />
            </div>
            <div>
              <label style={formLabel}>Description</label>
              <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="Detailed description, steps to reproduce, impact..." rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 120 }}>
                <label style={formLabel}>Priority</label>
                <select value={formPriority} onChange={(e) => setFormPriority(e.target.value)} style={inputStyle}>
                  {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.label}</option>)}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 120 }}>
                <label style={formLabel}>Category</label>
                <select value={formCategory} onChange={(e) => setFormCategory(e.target.value)} style={inputStyle}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label style={formLabel}>Assign to</label>
                <select value={formAssignee} onChange={(e) => setFormAssignee(e.target.value)} style={inputStyle}>
                  <option value="">Unassigned</option>
                  {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleAdd} disabled={!formTitle.trim() || saving} style={{ ...btnPrimary, opacity: (!formTitle.trim() || saving) ? 0.4 : 1 }}>{saving ? 'Saving...' : 'Log Issue'}</button>
              <button onClick={() => setShowAdd(false)} style={btnOutline}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap', alignItems: 'center' }}>
        {[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }, ...STATUSES.map((s) => ({ value: s.id, label: s.label }))].map((tab) => (
          <button key={tab.value} onClick={() => setFilterStatus(tab.value)} style={{
            padding: '7px 12px', fontSize: 11, fontWeight: filterStatus === tab.value ? 600 : 400,
            color: filterStatus === tab.value ? '#0f172a' : '#94a3b8',
            background: 'none', border: 'none',
            borderBottom: filterStatus === tab.value ? '2px solid #38bdf8' : '2px solid transparent',
            cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
          }}>
            {tab.label} <span style={{ fontSize: 9, marginLeft: 3, color: filterStatus === tab.value ? '#38bdf8' : '#cbd5e1' }}>{counts[tab.value] || 0}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)} style={{ fontSize: 11, border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 8px', outline: 'none', fontFamily: "'Outfit', sans-serif" }}>
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.label}</option>)}
        </select>
      </div>

      {/* List */}
      {loading ? (
        <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: 40 }}>Loading...</p>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb' }}>
          <p style={{ fontSize: 14, color: '#94a3b8' }}>No issues found.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map((issue) => {
            const sc = STATUSES.find((s) => s.id === issue.status) || STATUSES[0];
            const pr = PRIORITIES.find((p) => p.id === issue.priority) || PRIORITIES[2];
            const age = daysSince(issue.created_at);
            const ab = ageBadge(age);
            const isOpen = !['resolved', 'closed'].includes(issue.status);
            const expanded = expandedId === issue.id;

            return (
              <div key={issue.id} style={{
                background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
                borderLeft: `3px solid ${sc.colour}`,
                transition: 'all 0.15s',
              }}>
                <div
                  onClick={() => setExpandedId(expanded ? null : issue.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', cursor: 'pointer' }}
                >
                  {/* Priority icon */}
                  <span style={{ fontSize: 14, flexShrink: 0 }}>{pr.icon}</span>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, color: isOpen ? '#0f172a' : '#94a3b8', textDecoration: !isOpen ? 'line-through' : 'none' }}>
                      {issue.title}
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>{issue.category}</span>
                      <span>{staffMap[issue.assignee_id]?.name || 'Unassigned'}</span>
                      <span>{issue.reported_by_name}</span>
                      <span>{new Date(issue.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                    </div>
                  </div>

                  {/* Age badge */}
                  {isOpen && (
                    <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: ab.bg, color: ab.colour, flexShrink: 0 }}>
                      {ab.text}
                    </span>
                  )}

                  {/* Status */}
                  <select
                    value={issue.status}
                    onChange={(e) => { e.stopPropagation(); handleUpdate(issue.id, { status: e.target.value }); }}
                    onClick={(e) => e.stopPropagation()}
                    style={{ fontSize: 10, fontWeight: 600, color: sc.colour, background: sc.bg, border: 'none', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', outline: 'none', flexShrink: 0 }}
                  >
                    {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </div>

                {/* Expanded detail */}
                {expanded && (
                  <div style={{ padding: '0 18px 16px', borderTop: '1px solid #f1f5f9', marginTop: -2 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, paddingTop: 14, fontSize: 12 }}>
                      <div>
                        <span style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', fontWeight: 600 }}>Priority</span>
                        <div>
                          <select value={issue.priority} onChange={(e) => handleUpdate(issue.id, { priority: e.target.value })} style={inlineSelect}>
                            {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div>
                        <span style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', fontWeight: 600 }}>Category</span>
                        <div>
                          <select value={issue.category} onChange={(e) => handleUpdate(issue.id, { category: e.target.value })} style={inlineSelect}>
                            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                      </div>
                      <div>
                        <span style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', fontWeight: 600 }}>Assigned to</span>
                        <div>
                          <select value={issue.assignee_id || ''} onChange={(e) => handleUpdate(issue.id, { assignee_id: e.target.value || null })} style={inlineSelect}>
                            <option value="">Unassigned</option>
                            {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        </div>
                      </div>
                      <div>
                        <span style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', fontWeight: 600 }}>Age</span>
                        <div style={{ fontSize: 13, fontWeight: 500, color: '#0f172a' }}>{age} days</div>
                      </div>
                    </div>
                    {issue.description && (
                      <div style={{ marginTop: 12 }}>
                        <span style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', fontWeight: 600 }}>Description</span>
                        <div style={{ fontSize: 13, color: '#1e293b', marginTop: 4, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{issue.description}</div>
                      </div>
                    )}
                    {/* Resolution notes */}
                    <div style={{ marginTop: 12 }}>
                      <span style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', fontWeight: 600 }}>Resolution Notes</span>
                      <textarea
                        value={issue.resolution_notes || ''}
                        onChange={(e) => handleUpdate(issue.id, { resolution_notes: e.target.value })}
                        placeholder="Add resolution notes..."
                        rows={2}
                        style={{ ...inputStyle, marginTop: 4, fontSize: 12, resize: 'vertical' }}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 16px',
  fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff',
  border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
};
const btnOutline = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 14px',
  fontSize: 13, fontWeight: 600, background: '#fff', color: '#0f172a',
  border: '1px solid #e5e7eb', borderRadius: 10, cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
};
const inputStyle = {
  width: '100%', padding: '8px 12px', fontSize: 13, border: '1px solid #e5e7eb',
  borderRadius: 8, outline: 'none', fontFamily: "'Outfit', sans-serif", boxSizing: 'border-box',
};
const formLabel = {
  display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b',
  textTransform: 'uppercase', marginBottom: 4, fontFamily: "'Outfit', sans-serif",
};
const inlineSelect = {
  fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 8px',
  outline: 'none', fontFamily: "'Outfit', sans-serif", marginTop: 2,
};
