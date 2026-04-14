import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Download, Check, Send, Trash2, Pencil, ChevronDown, Minimize2, Maximize2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';

const VAT_RATE = 0.20;
const STATUS_CONFIG = {
  draft: { label: 'Draft', colour: '#64748b', bg: '#f1f5f9' },
  pending_approval: { label: 'Pending', colour: '#d97706', bg: '#fffbeb' },
  approved: { label: 'Approved', colour: '#059669', bg: '#f0fdf4' },
  pushed: { label: 'Pushed to QBO', colour: '#0e7fe0', bg: '#eff6ff' },
  rejected: { label: 'Rejected', colour: '#dc2626', bg: '#fef2f2' },
};
const SERVICES = ['Admin','Accounts Production','Corporation Tax','Self Assessment','VAT Returns','Bookkeeping','Payroll','Management Accounts','Company Secretarial','Advisory','SA302s','Accountant Certificates'];

export default function BillingPage() {
  const { profile } = useAuth();
  const [items, setItems] = useState([]);
  const [entities, setEntities] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [compact, setCompact] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);

  // Form state (shared for add + edit)
  const [formClient, setFormClient] = useState('');
  const [formService, setFormService] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formNet, setFormNet] = useState('');
  const [formVat, setFormVat] = useState('');
  const [formGross, setFormGross] = useState('');
  const [vatManual, setVatManual] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [{ data: bills }, { data: ents }, { data: staff }] = await Promise.all([
        supabase.from('billing_items').select('*').order('created_at', { ascending: false }),
        supabase.from('entities').select('id, name').order('name'),
        supabase.from('staff_profiles').select('id, full_name, name, email').order('name'),
      ]);
      setItems(bills || []);
      setEntities(ents || []);
      setStaffList((staff || []).map((s) => ({ ...s, name: s.full_name || s.name || s.email })));
    } catch (e) {
      console.error('[Billing] load error:', e);
      try { const { data: ents } = await supabase.from('entities').select('id, name').order('name'); setEntities(ents || []); } catch {}
    }
    setLoading(false);
  };

  const entityMap = useMemo(() => { const m = {}; entities.forEach((e) => { m[e.id] = e; }); return m; }, [entities]);
  const staffMap = useMemo(() => { const m = {}; staffList.forEach((s) => { m[s.id] = s; }); return m; }, [staffList]);
  const filtered = filter === 'all' ? items : items.filter((i) => i.status === filter);
  const counts = useMemo(() => {
    const c = { all: items.length };
    Object.keys(STATUS_CONFIG).forEach((k) => { c[k] = items.filter((i) => i.status === k).length; });
    return c;
  }, [items]);

  const resetForm = () => { setFormClient(''); setFormService(''); setFormDesc(''); setFormNet(''); setFormVat(''); setFormGross(''); setVatManual(false); };

  const updateNetCalc = (net, vatOverride) => {
    const n = parseFloat(net) || 0;
    if (!vatOverride) {
      const vt = Math.round(n * VAT_RATE * 100) / 100;
      setFormVat(vt ? vt.toFixed(2) : '');
      setFormGross(vt ? (n + vt).toFixed(2) : '');
    } else {
      const vt = parseFloat(formVat) || 0;
      setFormGross((n + vt).toFixed(2));
    }
  };

  const handleAdd = async () => {
    if (!formClient || !formService || !formNet) return;
    setSaving(true);
    const net = parseFloat(formNet) || 0;
    const vat = parseFloat(formVat) || Math.round(net * VAT_RATE * 100) / 100;
    const gross = Math.round((net + vat) * 100) / 100;
    try {
      await supabase.from('billing_items').insert({
        entity_id: formClient, service: formService, description: formDesc.trim() || null,
        net_amount: net, vat_amount: vat, gross_amount: gross,
        status: 'draft', created_by: profile?.id,
      });
      resetForm(); setShowAdd(false); await loadData();
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const handleUpdate = async (item) => {
    if (!formClient || !formService || !formNet) return;
    setSaving(true);
    const net = parseFloat(formNet) || 0;
    const vat = parseFloat(formVat) || Math.round(net * VAT_RATE * 100) / 100;
    const gross = Math.round((net + vat) * 100) / 100;
    try {
      await supabase.from('billing_items').update({
        entity_id: formClient, service: formService, description: formDesc.trim() || null,
        net_amount: net, vat_amount: vat, gross_amount: gross,
      }).eq('id', item.id);
      resetForm(); setEditingId(null); await loadData();
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const handleDelete = async (item) => {
    if (!window.confirm(`Delete billing item for ${entityMap[item.entity_id]?.name || 'Unknown'} — ${item.service}?`)) return;
    try {
      await supabase.from('billing_items').delete().eq('id', item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e) { console.error(e); }
  };

  const handleStatusChange = async (item, newStatus) => {
    const update = { status: newStatus };
    if (newStatus === 'approved') { update.approved_by = profile?.id; update.approved_at = new Date().toISOString(); }
    try {
      await supabase.from('billing_items').update(update).eq('id', item.id);
      setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, ...update } : i));
    } catch (e) { console.error(e); }
  };

  const startEdit = (item) => {
    setEditingId(item.id);
    setFormClient(item.entity_id || '');
    setFormService(item.service || '');
    setFormDesc(item.description || '');
    setFormNet(String(item.net_amount || ''));
    setFormVat(String(item.vat_amount || ''));
    setFormGross(String(item.gross_amount || ''));
    setVatManual(false);
    setShowAdd(false);
  };

  const handleExport = () => {
    const headers = ['Client','Service','Description','Net','VAT','Gross','Status','Added By','Date'];
    const rows = filtered.map((i) => [
      `"${(entityMap[i.entity_id]?.name || '').replace(/"/g,'""')}"`,
      `"${(i.service || '').replace(/"/g,'""')}"`,
      `"${(i.description || '').replace(/"/g,'""')}"`,
      (i.net_amount||0).toFixed(2), (i.vat_amount||0).toFixed(2), (i.gross_amount||0).toFixed(2),
      i.status,
      `"${(staffMap[i.created_by]?.name || '').replace(/"/g,'""')}"`,
      new Date(i.created_at).toLocaleDateString('en-GB'),
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url;
    a.download = `billing-${new Date().toISOString().split('T')[0]}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const fmt = (n) => new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',minimumFractionDigits:2}).format(n||0);

  // Inline form renderer (shared for add + edit)
  const renderForm = (onSubmit, submitLabel, onCancel) => (
    <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', padding:'20px 24px', marginBottom:20 }}>
      <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'flex-end' }}>
        <div style={{ flex:1, minWidth:160 }}>
          <label style={formLabel}>Client *</label>
          <select value={formClient} onChange={(e)=>setFormClient(e.target.value)} style={inputStyle}>
            <option value="">Select client...</option>
            {entities.map((e)=><option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div style={{ flex:1, minWidth:140 }}>
          <label style={formLabel}>Service *</label>
          <select value={formService} onChange={(e)=>setFormService(e.target.value)} style={inputStyle}>
            <option value="">Select service...</option>
            {SERVICES.map((s)=><option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ flex:2, minWidth:200 }}>
          <label style={formLabel}>Description</label>
          <input value={formDesc} onChange={(e)=>setFormDesc(e.target.value)} placeholder="Optional..." style={inputStyle} />
        </div>
        <div style={{ width:110 }}>
          <label style={formLabel}>Net (£) *</label>
          <input type="number" step="0.01" value={formNet} placeholder="0.00" style={inputStyle} onChange={(e)=>{setFormNet(e.target.value); updateNetCalc(e.target.value, vatManual);}} />
        </div>
        <div style={{ width:100 }}>
          <label style={formLabel}>VAT (£)</label>
          <input type="number" step="0.01" value={formVat} placeholder="0.00" style={inputStyle} onChange={(e)=>{setFormVat(e.target.value);setVatManual(true);const n=parseFloat(formNet)||0;setFormGross((n+(parseFloat(e.target.value)||0)).toFixed(2));}} />
        </div>
        <div style={{ width:110 }}>
          <label style={formLabel}>Gross (£)</label>
          <input type="number" value={formGross} placeholder="0.00" style={{...inputStyle,background:'#f8fafc'}} readOnly />
        </div>
        <div style={{ display:'flex', gap:6, alignItems:'flex-end', paddingBottom:1 }}>
          <button onClick={onSubmit} disabled={!formClient||!formService||!formNet||saving} style={{...btnPrimary, opacity:(!formClient||!formService||!formNet||saving)?0.4:1}}>
            {saving?'Saving...':submitLabel}
          </button>
          <button onClick={onCancel} style={btnOutline}>Cancel</button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ maxWidth:1000, margin:'0 auto', padding:'32px 24px', fontFamily:"'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:24 }}>
        <div>
          <h1 style={{ fontFamily:"'Playfair Display', serif", fontSize:26, fontWeight:500, color:'#0f172a', marginBottom:4 }}>Billing</h1>
          <p style={{ fontSize:13, color:'#64748b' }}>{items.length} items · {counts.pending_approval||0} awaiting approval</p>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <button onClick={()=>setCompact(!compact)} style={btnOutline} title={compact?'Full view':'Compact view'}>
            {compact ? <Maximize2 size={14}/> : <Minimize2 size={14}/>}
          </button>
          {filtered.length > 0 && <button onClick={handleExport} style={{...btnOutline, gap:5}}><Download size={14}/> Export</button>}
          <button onClick={()=>{setShowAdd(!showAdd);setEditingId(null);resetForm();}} style={btnPrimary}><Plus size={14}/> New Item</button>
        </div>
      </div>

      {/* Add form */}
      {showAdd && renderForm(handleAdd, 'Add', () => { setShowAdd(false); resetForm(); })}

      {/* Edit form (shown inline above the item) */}
      {editingId && !showAdd && renderForm(
        () => handleUpdate(items.find((i)=>i.id===editingId)),
        'Save',
        () => { setEditingId(null); resetForm(); }
      )}

      {/* Filter tabs */}
      <div style={{ display:'flex', gap:2, marginBottom:16, borderBottom:'1px solid #e5e7eb' }}>
        {[{value:'all',label:'All'}, ...Object.entries(STATUS_CONFIG).map(([k,v])=>({value:k,label:v.label}))].map((tab)=>(
          <button key={tab.value} onClick={()=>setFilter(tab.value)} style={{
            padding:'8px 14px', fontSize:12, fontWeight:filter===tab.value?600:400,
            color:filter===tab.value?'#0f172a':'#94a3b8', background:'none', border:'none',
            borderBottom:filter===tab.value?'2px solid #38bdf8':'2px solid transparent',
            cursor:'pointer', fontFamily:"'Outfit', sans-serif",
          }}>
            {tab.label} <span style={{fontSize:10, color:filter===tab.value?'#38bdf8':'#cbd5e1', marginLeft:4}}>{counts[tab.value]||0}</span>
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? <p style={{textAlign:'center',color:'#94a3b8',fontSize:13,padding:40}}>Loading...</p>
      : filtered.length === 0 ? (
        <div style={{textAlign:'center',padding:60,background:'#fff',borderRadius:12,border:'1px solid #e5e7eb'}}>
          <p style={{fontSize:14,color:'#94a3b8'}}>No billing items{filter!=='all'?` with status "${STATUS_CONFIG[filter]?.label}"`:''}</p>
        </div>
      ) : (
        <div style={{display:'flex',flexDirection:'column',gap: compact?3:6}}>
          {filtered.map((item) => {
            const sc = STATUS_CONFIG[item.status] || STATUS_CONFIG.draft;
            const clientName = entityMap[item.entity_id]?.name || 'Unknown';
            const createdByName = staffMap[item.created_by]?.name?.split(' ')[0] || '';
            const dateStr = new Date(item.created_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});

            if (compact) {
              return (
                <div key={item.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 12px', background:'#fff', borderRadius:8, border:'1px solid #e5e7eb', borderLeft:`3px solid ${sc.colour}`, fontSize:12 }}>
                  <span style={{fontWeight:500, color:'#0f172a', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{clientName} — {item.service}</span>
                  <span style={{fontWeight:600, color:'#0f172a', flexShrink:0}}>{fmt(item.gross_amount)}</span>
                  <span style={{fontSize:10, fontWeight:600, color:sc.colour, background:sc.bg, padding:'2px 6px', borderRadius:4, flexShrink:0}}>{sc.label}</span>
                  <span style={{fontSize:10, color:'#94a3b8', flexShrink:0}}>{createdByName} · {dateStr}</span>
                  <ActionButtons item={item} onEdit={()=>startEdit(item)} onDelete={()=>handleDelete(item)} onStatus={handleStatusChange} compact />
                </div>
              );
            }

            return (
              <div key={item.id} style={{ display:'flex', alignItems:'flex-start', gap:14, padding:'14px 18px', background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', borderLeft:`3px solid ${sc.colour}` }}>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontSize:14, fontWeight:500, color:'#0f172a', marginBottom:2}}>{clientName} — {item.service}</div>
                  {item.description && <div style={{fontSize:12, color:'#64748b'}}>{item.description}</div>}
                  <div style={{fontSize:11, color:'#94a3b8', marginTop:4, display:'flex', gap:8, alignItems:'center'}}>
                    <span style={{fontSize:10, fontWeight:600, color:sc.colour, background:sc.bg, padding:'2px 8px', borderRadius:6}}>{sc.label}</span>
                    <span>{createdByName && `Added by ${createdByName}`}</span>
                    <span>{dateStr}</span>
                  </div>
                </div>
                <div style={{textAlign:'right', flexShrink:0}}>
                  <div style={{fontSize:16, fontWeight:700, color:'#0f172a'}}>{fmt(item.gross_amount)}</div>
                  <div style={{fontSize:10, color:'#64748b'}}>{fmt(item.net_amount)} + {fmt(item.vat_amount)} VAT</div>
                </div>
                <ActionButtons item={item} onEdit={()=>startEdit(item)} onDelete={()=>handleDelete(item)} onStatus={handleStatusChange} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Action buttons (replaces status dropdown) ── */
function ActionButtons({ item, onEdit, onDelete, onStatus, compact }) {
  const s = item.status;
  const size = compact ? 12 : 14;
  const btnS = { background:'none', border:'none', cursor:'pointer', padding: compact?2:4, borderRadius:4, display:'inline-flex', transition:'color 0.12s' };

  return (
    <div style={{ display:'flex', gap: compact?2:4, alignItems:'center', flexShrink:0 }}>
      {s === 'draft' && (
        <button onClick={()=>onStatus(item,'pending_approval')} style={{...btnS}} title="Submit for approval" onMouseEnter={(e)=>e.currentTarget.style.color='#d97706'} onMouseLeave={(e)=>e.currentTarget.style.color='#94a3b8'}>
          <Send size={size} style={{color:'#94a3b8'}} />
        </button>
      )}
      {s === 'pending_approval' && (
        <button onClick={()=>onStatus(item,'approved')} style={{...btnS}} title="Approve" onMouseEnter={(e)=>e.currentTarget.style.color='#059669'} onMouseLeave={(e)=>e.currentTarget.style.color='#94a3b8'}>
          <Check size={size} style={{color:'#94a3b8'}} />
        </button>
      )}
      {s === 'approved' && (
        <button onClick={()=>onStatus(item,'pushed')} style={{...btnS}} title="Mark as pushed to QBO" onMouseEnter={(e)=>e.currentTarget.style.color='#0e7fe0'} onMouseLeave={(e)=>e.currentTarget.style.color='#94a3b8'}>
          <Send size={size} style={{color:'#94a3b8'}} />
        </button>
      )}
      {s !== 'pushed' && (
        <button onClick={onEdit} style={{...btnS}} title="Edit" onMouseEnter={(e)=>e.currentTarget.style.color='#0e7fe0'} onMouseLeave={(e)=>e.currentTarget.style.color='#cbd5e1'}>
          <Pencil size={size} style={{color:'#cbd5e1'}} />
        </button>
      )}
      <button onClick={onDelete} style={{...btnS}} title="Delete" onMouseEnter={(e)=>e.currentTarget.style.color='#ef4444'} onMouseLeave={(e)=>e.currentTarget.style.color='#cbd5e1'}>
        <Trash2 size={size} style={{color:'#cbd5e1'}} />
      </button>
    </div>
  );
}

const btnPrimary = { display:'inline-flex', alignItems:'center', gap:5, padding:'8px 14px', fontSize:13, fontWeight:600, background:'#0f172a', color:'#fff', border:'none', borderRadius:10, cursor:'pointer', fontFamily:"'Outfit', sans-serif" };
const btnOutline = { display:'inline-flex', alignItems:'center', gap:4, padding:'8px 14px', fontSize:13, fontWeight:600, background:'#fff', color:'#0f172a', border:'1px solid #e5e7eb', borderRadius:10, cursor:'pointer', fontFamily:"'Outfit', sans-serif" };
const inputStyle = { width:'100%', padding:'8px 12px', fontSize:13, border:'1px solid #e5e7eb', borderRadius:8, outline:'none', fontFamily:"'Outfit', sans-serif", boxSizing:'border-box' };
const formLabel = { display:'block', fontSize:11, fontWeight:600, color:'#64748b', textTransform:'uppercase', marginBottom:4, fontFamily:"'Outfit', sans-serif" };
