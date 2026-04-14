import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Download, Check, Clock, Send, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';

/* ─── Billing Module ──────────────────────────────────────── */
const VAT_RATE = 0.20;

const STATUS_CONFIG = {
  draft: { label: 'Draft', colour: '#64748b', bg: '#f1f5f9', icon: Clock },
  pending_approval: { label: 'Pending Approval', colour: '#d97706', bg: '#fffbeb', icon: Clock },
  approved: { label: 'Approved', colour: '#059669', bg: '#f0fdf4', icon: Check },
  pushed: { label: 'Pushed to QBO', colour: '#0e7fe0', bg: '#eff6ff', icon: Send },
  rejected: { label: 'Rejected', colour: '#dc2626', bg: '#fef2f2', icon: X },
};

export default function BillingPage() {
  const { profile } = useAuth();
  const [items, setItems] = useState([]);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [showAdd, setShowAdd] = useState(false);

  // New item form
  const [formClient, setFormClient] = useState('');
  const [formService, setFormService] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formNet, setFormNet] = useState('');
  const [formVat, setFormVat] = useState('');
  const [formGross, setFormGross] = useState('');
  const [vatManual, setVatManual] = useState(false); // true if user overrode VAT
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [{ data: bills }, { data: ents }] = await Promise.all([
        supabase.from('billing_items').select('*').order('created_at', { ascending: false }),
        supabase.from('entities').select('id, name').order('name'),
      ]);
      setItems(bills || []);
      setEntities(ents || []);
    } catch (e) {
      console.error('[Billing] load error:', e);
      // Table may not exist yet
      try { const { data: ents } = await supabase.from('entities').select('id, name').order('name'); setEntities(ents || []); } catch {}
    }
    setLoading(false);
  };

  const entityMap = useMemo(() => {
    const m = {};
    entities.forEach((e) => { m[e.id] = e; });
    return m;
  }, [entities]);

  const filtered = filter === 'all' ? items : items.filter((i) => i.status === filter);

  const counts = useMemo(() => {
    const c = { all: items.length };
    Object.keys(STATUS_CONFIG).forEach((k) => { c[k] = items.filter((i) => i.status === k).length; });
    return c;
  }, [items]);

  const handleAdd = async () => {
    if (!formClient || !formService || !formNet) return;
    setSaving(true);
    const net = parseFloat(formNet) || 0;
    const vat = parseFloat(formVat) || Math.round(net * VAT_RATE * 100) / 100;
    const gross = parseFloat(formGross) || Math.round((net + vat) * 100) / 100;

    try {
      const { error } = await supabase.from('billing_items').insert({
        entity_id: formClient,
        service: formService,
        description: formDesc.trim() || null,
        net_amount: net,
        vat_amount: vat,
        gross_amount: gross,
        status: 'draft',
        created_by: profile?.id,
      });
      if (error) { console.error('[Billing] insert error:', error); }
      else {
        setFormClient(''); setFormService(''); setFormDesc(''); setFormNet(''); setFormVat(''); setFormGross(''); setVatManual(false);
        setShowAdd(false);
        await loadData();
      }
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const handleStatusChange = async (item, newStatus) => {
    try {
      const update = { status: newStatus };
      if (newStatus === 'approved') update.approved_by = profile?.id;
      if (newStatus === 'approved') update.approved_at = new Date().toISOString();
      await supabase.from('billing_items').update(update).eq('id', item.id);
      setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, ...update } : i));
    } catch (e) { console.error(e); }
  };

  const handleExport = () => {
    const headers = ['Client', 'Service', 'Description', 'Net', 'VAT', 'Gross', 'Status', 'Date'];
    const rows = filtered.map((i) => [
      `"${(entityMap[i.entity_id]?.name || '').replace(/"/g, '""')}"`,
      `"${(i.service || '').replace(/"/g, '""')}"`,
      `"${(i.description || '').replace(/"/g, '""')}"`,
      (i.net_amount || 0).toFixed(2),
      (i.vat_amount || 0).toFixed(2),
      (i.gross_amount || 0).toFixed(2),
      i.status,
      new Date(i.created_at).toLocaleDateString('en-GB'),
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `billing-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const fmt = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2 }).format(n || 0);

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '32px 24px', fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 4 }}>Billing</h1>
          <p style={{ fontSize: 13, color: '#64748b' }}>{items.length} items · {counts.pending_approval || 0} awaiting approval</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {filtered.length > 0 && (
            <button onClick={handleExport} style={{ ...btnStyle, gap: 5 }}><Download size={14} /> Export</button>
          )}
          <button onClick={() => setShowAdd(!showAdd)} style={{ ...btnStyle, background: '#0f172a', color: '#fff', border: 'none' }}>
            <Plus size={14} /> New Item
          </button>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label style={formLabel}>Client *</label>
              <select value={formClient} onChange={(e) => setFormClient(e.target.value)} style={inputStyle}>
                <option value="">Select client...</option>
                {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label style={formLabel}>Service *</label>
              <input value={formService} onChange={(e) => setFormService(e.target.value)} placeholder="e.g. Accounts Production" style={inputStyle} />
            </div>
            <div style={{ flex: 2, minWidth: 200 }}>
              <label style={formLabel}>Description</label>
              <input value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="Optional description..." style={inputStyle} />
            </div>
            <div style={{ width: 110 }}>
              <label style={formLabel}>Net (£) *</label>
              <input
                type="number" step="0.01" value={formNet} placeholder="0.00" style={inputStyle}
                onChange={(e) => {
                  const v = e.target.value;
                  setFormNet(v);
                  if (!vatManual) {
                    const n = parseFloat(v) || 0;
                    const vt = Math.round(n * VAT_RATE * 100) / 100;
                    setFormVat(vt ? vt.toFixed(2) : '');
                    setFormGross(vt ? (n + vt).toFixed(2) : '');
                  } else {
                    const n = parseFloat(v) || 0;
                    const vt = parseFloat(formVat) || 0;
                    setFormGross((n + vt).toFixed(2));
                  }
                }}
              />
            </div>
            <div style={{ width: 100 }}>
              <label style={formLabel}>VAT (£)</label>
              <input
                type="number" step="0.01" value={formVat} placeholder="0.00" style={inputStyle}
                onChange={(e) => {
                  setFormVat(e.target.value);
                  setVatManual(true);
                  const n = parseFloat(formNet) || 0;
                  const v = parseFloat(e.target.value) || 0;
                  setFormGross((n + v).toFixed(2));
                }}
              />
            </div>
            <div style={{ width: 110 }}>
              <label style={formLabel}>Gross (£)</label>
              <input type="number" step="0.01" value={formGross} placeholder="0.00" style={{ ...inputStyle, background: '#f8fafc' }} readOnly />
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', paddingBottom: 1 }}>
              <button onClick={handleAdd} disabled={!formClient || !formService || !formNet || saving} style={{ ...btnStyle, background: '#0f172a', color: '#fff', border: 'none', opacity: (!formClient || !formService || !formNet || saving) ? 0.4 : 1 }}>
                {saving ? 'Saving...' : 'Add'}
              </button>
              <button onClick={() => setShowAdd(false)} style={btnStyle}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid #e5e7eb' }}>
        {[{ value: 'all', label: 'All' }, ...Object.entries(STATUS_CONFIG).map(([k, v]) => ({ value: k, label: v.label }))].map((tab) => (
          <button key={tab.value} onClick={() => setFilter(tab.value)} style={{
            padding: '8px 14px', fontSize: 12, fontWeight: filter === tab.value ? 600 : 400,
            color: filter === tab.value ? '#0f172a' : '#94a3b8',
            background: 'none', border: 'none',
            borderBottom: filter === tab.value ? '2px solid #38bdf8' : '2px solid transparent',
            cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
          }}>
            {tab.label} <span style={{ fontSize: 10, color: filter === tab.value ? '#38bdf8' : '#cbd5e1', marginLeft: 4 }}>{counts[tab.value] || 0}</span>
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: 40 }}>Loading...</p>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb' }}>
          <p style={{ fontSize: 14, color: '#94a3b8' }}>No billing items{filter !== 'all' ? ` with status "${STATUS_CONFIG[filter]?.label}"` : ''}.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map((item) => {
            const sc = STATUS_CONFIG[item.status] || STATUS_CONFIG.draft;
            const clientName = entityMap[item.entity_id]?.name || 'Unknown';
            return (
              <div key={item.id} style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px',
                background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
                borderLeft: `3px solid ${sc.colour}`,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
                    {clientName} — {item.service}
                  </div>
                  {item.description && <div style={{ fontSize: 12, color: '#64748b' }}>{item.description}</div>}
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                    {new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{fmt(item.gross_amount)}</div>
                  <div style={{ fontSize: 10, color: '#64748b' }}>
                    {fmt(item.net_amount)} + {fmt(item.vat_amount)} VAT
                  </div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <select
                    value={item.status}
                    onChange={(e) => handleStatusChange(item, e.target.value)}
                    style={{
                      fontSize: 11, fontWeight: 600, color: sc.colour, background: sc.bg,
                      border: 'none', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', outline: 'none',
                    }}
                  >
                    <option value="draft">Draft</option>
                    <option value="pending_approval">Pending Approval</option>
                    <option value="approved">Approved</option>
                    <option value="pushed">Pushed to QBO</option>
                    <option value="rejected">Rejected</option>
                  </select>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const btnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 14px',
  fontSize: 13, fontWeight: 600, border: '1px solid #e5e7eb', borderRadius: 10,
  background: '#fff', color: '#0f172a', cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
};
const inputStyle = {
  width: '100%', padding: '8px 12px', fontSize: 13, border: '1px solid #e5e7eb',
  borderRadius: 8, outline: 'none', fontFamily: "'Outfit', sans-serif", boxSizing: 'border-box',
};
const formLabel = {
  display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b',
  textTransform: 'uppercase', marginBottom: 4, fontFamily: "'Outfit', sans-serif",
};
