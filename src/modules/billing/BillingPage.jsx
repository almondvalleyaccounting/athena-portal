import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Download, Check, Send, Trash2, Pencil, Minimize2, Maximize2, AlertTriangle } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { pushBillingItems } from '../../lib/qboApi';
import { useAuth } from '../../shell/AppShell';

const VAT_RATE = 0.20;
const STATUS_CONFIG = {
  draft: { label: 'Draft', colour: '#64748b', bg: '#f1f5f9' },
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
  const [filter, setFilter] = useState('pipeline'); // default to pipeline
  const [compact, setCompact] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [showPushConfirm, setShowPushConfirm] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [sendMode, setSendMode] = useState('send'); // 'send' | 'draft'
  const [pushResults, setPushResults] = useState(null); // { summary, results } | { error }
  const [preview, setPreview] = useState(null); // dry-run plan rows
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

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
        supabase.from('staff_profiles').select('*').order('name'),
      ]);
      setItems(bills || []);
      setEntities(ents || []);
      setStaffList((staff || []).map((s) => ({ ...s, name: s.full_name || s.name || s.email || 'Unknown' })));
    } catch (e) { console.error('[Billing] load error:', e); }
    setLoading(false);
  };

  const entityMap = useMemo(() => { const m = {}; entities.forEach((e) => { m[e.id] = e; }); return m; }, [entities]);
  const staffMap = useMemo(() => { const m = {}; staffList.forEach((s) => { m[s.id] = s; }); return m; }, [staffList]);

  // Pipeline = draft + approved (everything not yet pushed or rejected)
  const filtered = useMemo(() => {
    if (filter === 'pipeline') return items.filter((i) => i.status === 'draft' || i.status === 'approved');
    if (filter === 'all') return items;
    return items.filter((i) => i.status === filter);
  }, [items, filter]);

  const counts = useMemo(() => {
    const c = { all: items.length, pipeline: items.filter((i) => i.status === 'draft' || i.status === 'approved').length };
    Object.keys(STATUS_CONFIG).forEach((k) => { c[k] = items.filter((i) => i.status === k).length; });
    return c;
  }, [items]);

  // Totals for filtered view
  const totals = useMemo(() => {
    let net = 0, vat = 0, gross = 0;
    filtered.forEach((i) => { net += i.net_amount || 0; vat += i.vat_amount || 0; gross += i.gross_amount || 0; });
    return { net, vat, gross };
  }, [filtered]);

  const fmt = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2 }).format(n || 0);
  const resetForm = () => { setFormClient(''); setFormService(''); setFormDesc(''); setFormNet(''); setFormVat(''); setFormGross(''); setVatManual(false); };

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
      setSelected((prev) => { const n = new Set(prev); n.delete(item.id); return n; });
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

  // Batch push to QB
  const approvedItems = items.filter((i) => i.status === 'approved');
  const selectedApproved = approvedItems.filter((i) => selected.has(i.id));
  const pushTargets = selectedApproved.length > 0 ? selectedApproved : approvedItems;

  const handleBatchPush = async () => {
    setPushing(true);
    setPushResults(null);
    try {
      const result = await pushBillingItems(
        pushTargets.map((i) => i.id),
        sendMode === 'send',
        profile?.id,
      );
      setPushResults(result);
      await loadData();
      setSelected(new Set());
      // Keep the modal open only if something errored, so the user can read why.
      if (!result?.summary?.errored) setShowPushConfirm(false);
    } catch (e) {
      console.error(e);
      setPushResults({ error: e.message || 'Push to QuickBooks failed' });
    }
    setPushing(false);
  };

  // Fetch a read-only QBO plan when the confirm modal opens, so we can
  // show exactly what will happen (new vs existing customer, send vs
  // draft) before committing. Doesn't depend on sendMode — the send/draft
  // line is derived client-side from the plan's has_email flag.
  useEffect(() => {
    if (!showPushConfirm) { setPreview(null); setPreviewError(null); return; }
    let cancelled = false;
    const ids = pushTargets.map((i) => i.id);
    if (ids.length === 0) return;
    setPreviewLoading(true); setPreviewError(null);
    pushBillingItems(ids, true, profile?.id, true)
      .then((res) => { if (!cancelled) setPreview(res?.plan || []); })
      .catch((e) => { if (!cancelled) setPreviewError(e.message || 'Could not load preview'); })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [showPushConfirm]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = (item) => {
    setEditingId(item.id); setShowAdd(false);
    setFormClient(item.entity_id || ''); setFormService(item.service || '');
    setFormDesc(item.description || ''); setFormNet(String(item.net_amount || ''));
    setFormVat(String(item.vat_amount || '')); setFormGross(String(item.gross_amount || ''));
    setVatManual(false);
  };

  const toggleSelect = (id) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleSelectAll = () => { if (selected.size === filtered.length) setSelected(new Set()); else setSelected(new Set(filtered.map((i) => i.id))); };

  const handleExport = () => {
    const toExport = selected.size > 0 ? filtered.filter((i) => selected.has(i.id)) : filtered;
    const headers = ['Client','Service','Description','Net','VAT','Gross','Status','Added By','Date'];
    const rows = toExport.map((i) => [
      `"${(entityMap[i.entity_id]?.name||'').replace(/"/g,'""')}"`,`"${(i.service||'').replace(/"/g,'""')}"`,
      `"${(i.description||'').replace(/"/g,'""')}"`, (i.net_amount||0).toFixed(2),(i.vat_amount||0).toFixed(2),(i.gross_amount||0).toFixed(2),
      i.status, `"${(staffMap[i.created_by]?.name||'Unknown').replace(/"/g,'""')}"`,
      new Date(i.created_at).toLocaleDateString('en-GB'),
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url;
    a.download=`billing-${new Date().toISOString().split('T')[0]}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const renderForm = (onSubmit, submitLabel, onCancel) => (
    <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', padding:'20px 24px', marginBottom:20 }}>
      <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'flex-end' }}>
        <div style={{flex:1,minWidth:160}}><label style={formLabel}>Client *</label>
          <select value={formClient} onChange={(e)=>setFormClient(e.target.value)} style={inputStyle}><option value="">Select client...</option>{entities.map((e)=><option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
        <div style={{flex:1,minWidth:140}}><label style={formLabel}>Service *</label>
          <select value={formService} onChange={(e)=>setFormService(e.target.value)} style={inputStyle}><option value="">Select service...</option>{SERVICES.map((s)=><option key={s} value={s}>{s}</option>)}</select></div>
        <div style={{flex:2,minWidth:200}}><label style={formLabel}>Description</label>
          <input value={formDesc} onChange={(e)=>setFormDesc(e.target.value)} placeholder="Optional..." style={inputStyle}/></div>
        <div style={{width:110}}><label style={formLabel}>Net (£) *</label>
          <input type="number" step="0.01" value={formNet} placeholder="0.00" style={inputStyle} onChange={(e)=>{setFormNet(e.target.value);const n=parseFloat(e.target.value)||0;if(!vatManual){const vt=Math.round(n*VAT_RATE*100)/100;setFormVat(vt?vt.toFixed(2):'');setFormGross(vt?(n+vt).toFixed(2):'');}else{setFormGross((n+(parseFloat(formVat)||0)).toFixed(2));}}}/></div>
        <div style={{width:100}}><label style={formLabel}>VAT (£)</label>
          <input type="number" step="0.01" value={formVat} placeholder="0.00" style={inputStyle} onChange={(e)=>{setFormVat(e.target.value);setVatManual(true);setFormGross(((parseFloat(formNet)||0)+(parseFloat(e.target.value)||0)).toFixed(2));}}/></div>
        <div style={{width:110}}><label style={formLabel}>Gross (£)</label>
          <input type="number" value={formGross} placeholder="0.00" style={{...inputStyle,background:'#f8fafc'}} readOnly/></div>
        <div style={{display:'flex',gap:6,alignItems:'flex-end',paddingBottom:1}}>
          <button onClick={onSubmit} disabled={!formClient||!formService||!formNet||saving} style={{...btnPrimary,opacity:(!formClient||!formService||!formNet||saving)?0.4:1}}>{saving?'Saving...':submitLabel}</button>
          <button onClick={onCancel} style={btnOutline}>Cancel</button></div>
      </div>
    </div>
  );

  return (
    <div style={{maxWidth:1000,margin:'0 auto',padding:'32px 24px',fontFamily:"'Outfit', sans-serif"}}>
      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:24}}>
        <div>
          <h1 style={{fontFamily:"'Playfair Display', serif",fontSize:26,fontWeight:500,color:'#0f172a',marginBottom:4}}>Billing</h1>
          <p style={{fontSize:13,color:'#64748b'}}>{counts.pipeline} in pipeline · {counts.all} total</p>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {approvedItems.length > 0 && (
            <button onClick={()=>{setShowPushConfirm(true);setPushResults(null);}} style={{...btnPrimary,background:'#059669',gap:5}}>
              <Send size={14}/> Push to QB ({selectedApproved.length > 0 ? selectedApproved.length : approvedItems.length})
            </button>
          )}
          <button onClick={()=>setCompact(!compact)} style={btnOutline} title={compact?'Full view':'Compact view'}>
            {compact?<Maximize2 size={14}/>:<Minimize2 size={14}/>}
          </button>
          {filtered.length>0 && <button onClick={handleExport} style={{...btnOutline,gap:5}}><Download size={14}/> Export{selected.size>0?` (${selected.size})`:''}</button>}
          <button onClick={()=>{setShowAdd(!showAdd);setEditingId(null);resetForm();}} style={btnPrimary}><Plus size={14}/> New Item</button>
        </div>
      </div>

      {showAdd && renderForm(handleAdd, 'Add', ()=>{setShowAdd(false);resetForm();})}
      {editingId && !showAdd && renderForm(()=>handleUpdate(items.find((i)=>i.id===editingId)), 'Save', ()=>{setEditingId(null);resetForm();})}

      {/* Filter tabs */}
      <div style={{display:'flex',gap:2,marginBottom:16,borderBottom:'1px solid #e5e7eb'}}>
        {[{value:'pipeline',label:'Pipeline'},{value:'all',label:'All'},...Object.entries(STATUS_CONFIG).map(([k,v])=>({value:k,label:v.label}))].map((tab)=>(
          <button key={tab.value} onClick={()=>{setFilter(tab.value);setSelected(new Set());}} style={{
            padding:'8px 14px',fontSize:12,fontWeight:filter===tab.value?600:400,
            color:filter===tab.value?'#0f172a':'#94a3b8',background:'none',border:'none',
            borderBottom:filter===tab.value?'2px solid #38bdf8':'2px solid transparent',
            cursor:'pointer',fontFamily:"'Outfit', sans-serif",
          }}>
            {tab.label} <span style={{fontSize:10,color:filter===tab.value?'#38bdf8':'#cbd5e1',marginLeft:4}}>{counts[tab.value]||0}</span>
          </button>
        ))}
      </div>

      {/* Totals bar */}
      {filtered.length > 0 && (
        <div style={{display:'flex',gap:20,marginBottom:16,padding:'10px 18px',background:'#f8fafc',borderRadius:10,fontSize:13}}>
          <span style={{color:'#64748b'}}>{filtered.length} items</span>
          <span><b style={{color:'#0f172a'}}>Net:</b> {fmt(totals.net)}</span>
          <span><b style={{color:'#0f172a'}}>VAT:</b> {fmt(totals.vat)}</span>
          <span><b style={{color:'#0e7fe0'}}>Gross:</b> <b>{fmt(totals.gross)}</b></span>
        </div>
      )}

      {/* Select all */}
      {filtered.length > 0 && (
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8,padding:'0 4px'}}>
          <input type="checkbox" checked={selected.size===filtered.length&&filtered.length>0} onChange={toggleSelectAll} style={{width:14,height:14,cursor:'pointer',accentColor:'#0e7fe0'}}/>
          <span style={{fontSize:11,color:'#94a3b8'}}>Select all</span>
        </div>
      )}

      {/* List */}
      {loading ? <p style={{textAlign:'center',color:'#94a3b8',fontSize:13,padding:40}}>Loading...</p>
      : filtered.length===0 ? (
        <div style={{textAlign:'center',padding:60,background:'#fff',borderRadius:12,border:'1px solid #e5e7eb'}}>
          <p style={{fontSize:14,color:'#94a3b8'}}>No billing items in this view.</p>
        </div>
      ) : (
        <div style={{display:'flex',flexDirection:'column',gap:compact?3:6}}>
          {filtered.map((item)=>{
            const sc = STATUS_CONFIG[item.status]||STATUS_CONFIG.draft;
            const clientName = entityMap[item.entity_id]?.name||'Unknown';
            const addedBy = staffMap[item.created_by]?.name || 'Unknown';
            const dateStr = new Date(item.created_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
            const isSelected = selected.has(item.id);

            if (compact) return (
              <div key={item.id} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 12px',background:isSelected?'#eff6ff':'#fff',borderRadius:8,border:`1px solid ${isSelected?'#0e7fe0':'#e5e7eb'}`,borderLeft:`3px solid ${sc.colour}`,fontSize:12}}>
                <input type="checkbox" checked={isSelected} onChange={()=>toggleSelect(item.id)} style={{width:13,height:13,cursor:'pointer',accentColor:'#0e7fe0',flexShrink:0}}/>
                <span style={{fontWeight:500,color:'#0f172a',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{clientName} — {item.service}</span>
                <span style={{fontWeight:600,color:'#0f172a',flexShrink:0}}>{fmt(item.gross_amount)}</span>
                <span style={{fontSize:10,fontWeight:600,color:sc.colour,background:sc.bg,padding:'2px 6px',borderRadius:4,flexShrink:0}}>{sc.label}</span>
                <span style={{fontSize:10,color:'#94a3b8',flexShrink:0}}>{addedBy} · {dateStr}</span>
                <ActionButtons item={item} onEdit={()=>startEdit(item)} onDelete={()=>handleDelete(item)} onStatus={handleStatusChange} compact/>
              </div>
            );

            return (
              <div key={item.id} style={{display:'flex',alignItems:'flex-start',gap:12,padding:'14px 18px',background:isSelected?'#eff6ff':'#fff',borderRadius:12,border:`1px solid ${isSelected?'#0e7fe0':'#e5e7eb'}`,borderLeft:`3px solid ${sc.colour}`}}>
                <input type="checkbox" checked={isSelected} onChange={()=>toggleSelect(item.id)} style={{width:14,height:14,cursor:'pointer',accentColor:'#0e7fe0',marginTop:3,flexShrink:0}}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:500,color:'#0f172a',marginBottom:2}}>{clientName} — {item.service}</div>
                  {item.description && <div style={{fontSize:12,color:'#64748b'}}>{item.description}</div>}
                  <div style={{fontSize:11,color:'#94a3b8',marginTop:4,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    <span style={{fontSize:10,fontWeight:600,color:sc.colour,background:sc.bg,padding:'2px 8px',borderRadius:6}}>{sc.label}</span>
                    <span>Added by {addedBy}</span>
                    <span>{dateStr}</span>
                  </div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <div style={{fontSize:16,fontWeight:700,color:'#0f172a'}}>{fmt(item.gross_amount)}</div>
                  <div style={{fontSize:10,color:'#64748b'}}>{fmt(item.net_amount)} + {fmt(item.vat_amount)} VAT</div>
                </div>
                <ActionButtons item={item} onEdit={()=>startEdit(item)} onDelete={()=>handleDelete(item)} onStatus={handleStatusChange}/>
              </div>
            );
          })}
        </div>
      )}

      {/* Push to QB confirmation modal */}
      {showPushConfirm && (
        <div onClick={()=>setShowPushConfirm(false)} style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
          <div onClick={(e)=>e.stopPropagation()} style={{background:'#fff',borderRadius:16,padding:'32px',maxWidth:480,width:'100%',boxShadow:'0 20px 60px rgba(0,0,0,0.15)'}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
              <AlertTriangle size={24} style={{color:'#d97706'}}/>
              <h2 style={{fontFamily:"'Playfair Display', serif",fontSize:20,fontWeight:500,color:'#0f172a',margin:0}}>Confirm Push to QuickBooks</h2>
            </div>
            <p style={{fontSize:13,color:'#64748b',marginBottom:14,lineHeight:1.6}}>
              You are about to create QuickBooks invoices for <b>{pushTargets.length} approved billing item{pushTargets.length!==1?'s':''}</b> (VAT at the standard 20% rate).
            </p>

            {/* Send mode */}
            <div style={{display:'flex',gap:8,marginBottom:16}}>
              <button onClick={()=>setSendMode('send')} style={{...modeBtn, ...(sendMode==='send'?modeBtnActive:{})}}>
                <div style={{fontWeight:600,fontSize:13}}>Create &amp; send now</div>
                <div style={{fontSize:11,color:'#64748b'}}>Email each invoice to the client immediately</div>
              </button>
              <button onClick={()=>setSendMode('draft')} style={{...modeBtn, ...(sendMode==='draft'?modeBtnActive:{})}}>
                <div style={{fontWeight:600,fontSize:13}}>Create as draft</div>
                <div style={{fontSize:11,color:'#64748b'}}>Don&apos;t send — you&apos;ll send these from QBO later</div>
              </button>
            </div>

            {/* Per-item results after a push attempt */}
            {pushResults && (
              <div style={{marginBottom:16,padding:'10px 14px',borderRadius:8,background:pushResults.error?'#fef2f2':'#f8fafc',border:`1px solid ${pushResults.error?'#fecaca':'#e5e7eb'}`}}>
                {pushResults.error ? (
                  <div style={{fontSize:12,color:'#b91c1c'}}>{pushResults.error}</div>
                ) : (
                  <>
                    <div style={{fontSize:12,fontWeight:600,color:'#0f172a',marginBottom:6}}>
                      {pushResults.summary.sent} sent · {pushResults.summary.created_unsent} draft{pushResults.summary.errored?` · ${pushResults.summary.errored} failed`:''}
                    </div>
                    {(pushResults.results||[]).filter((r)=>r.status==='error'||r.reason).map((r)=>(
                      <div key={r.billing_item_id} style={{fontSize:11,color:r.status==='error'?'#b91c1c':'#92400e',padding:'2px 0'}}>
                        <b>{r.entity}:</b> {r.reason || r.status}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
            <div style={{background:'#f8fafc',borderRadius:8,padding:'12px 16px',marginBottom:20,maxHeight:260,overflowY:'auto'}}>
              {previewLoading && <div style={{fontSize:12,color:'#94a3b8',padding:'4px 0'}}>Checking QuickBooks…</div>}
              {previewError && <div style={{fontSize:12,color:'#b91c1c',padding:'4px 0'}}>Couldn&apos;t load preview: {previewError}</div>}
              {pushTargets.map((item)=>{
                const p = preview?.find((r)=>r.billing_item_id===item.id);
                const willSend = sendMode==='send' && p?.has_email;
                const sendType = !p ? null
                  : willSend ? { tone:'green', text:'Send: immediately' }
                  : (sendMode==='send' && !p.has_email) ? { tone:'amber', text:'Send: later (no client email)' }
                  : { tone:'slate', text:'Send: later (manually from QBO)' };
                return (
                  <div key={item.id} style={{padding:'8px 0',borderBottom:'1px solid #f1f5f9'}}>
                    <div style={{display:'flex',justifyContent:'space-between',fontSize:12}}>
                      <span style={{fontWeight:600,color:'#0f172a'}}>{entityMap[item.entity_id]?.name} — {item.service}</span>
                      <span style={{fontWeight:600}}>{fmt(item.gross_amount)}</span>
                    </div>
                    {p && (
                      <div style={{display:'flex',flexWrap:'wrap',gap:6,marginTop:4}}>
                        <Chip tone="slate" text="Type: one-off invoice" />
                        <Chip tone={p.customer_action==='create'?'amber':'slate'} text={p.customer_action==='create'?'New customer' : 'Existing customer'} />
                        <Chip tone={sendType.tone} text={sendType.text} />
                        {willSend && <Chip tone="slate" text={`→ ${p.email}${p.email_source==='quickbooks'?' (from QBO)':''}`} />}
                        {!p.approved && <Chip tone="red" text="Not approved — will be skipped" />}
                      </div>
                    )}
                    <div style={{fontSize:10,color:'#94a3b8',marginTop:3}}>{fmt(item.net_amount)} net + {fmt(item.vat_amount)} VAT</div>
                  </div>
                );
              })}
              <div style={{display:'flex',justifyContent:'space-between',fontSize:13,fontWeight:700,padding:'8px 0 0',borderTop:'2px solid #e5e7eb',marginTop:4}}>
                <span>Total</span>
                <span style={{color:'#0e7fe0'}}>{fmt(pushTargets.reduce((s,i)=>s+(i.gross_amount||0),0))}</span>
              </div>
            </div>
            <div style={{display:'flex',gap:10}}>
              <button onClick={()=>{setShowPushConfirm(false);setPushResults(null);}} style={{...btnOutline,flex:1}}>{pushResults && !pushResults.error ? 'Close' : 'Cancel'}</button>
              <button onClick={handleBatchPush} disabled={pushing} style={{...btnPrimary,flex:1,background:'#059669',justifyContent:'center',opacity:pushing?0.5:1}}>
                {pushing?'Pushing...':(sendMode==='send'?'Create & send':'Create drafts')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionButtons({ item, onEdit, onDelete, onStatus, compact }) {
  const s = item.status;
  const sz = compact?12:14;
  const b = {background:'none',border:'none',cursor:'pointer',padding:compact?2:4,borderRadius:4,display:'inline-flex',transition:'color 0.12s'};
  return (
    <div style={{display:'flex',gap:compact?2:4,alignItems:'center',flexShrink:0}}>
      {s==='draft' && <button onClick={()=>onStatus(item,'approved')} style={b} title="Approve"><Check size={sz} style={{color:'#94a3b8'}} onMouseEnter={e=>e.target.style.color='#059669'} onMouseLeave={e=>e.target.style.color='#94a3b8'}/></button>}
      {s!=='pushed' && <button onClick={onEdit} style={b} title="Edit"><Pencil size={sz} style={{color:'#cbd5e1'}}/></button>}
      <button onClick={onDelete} style={b} title="Delete"><Trash2 size={sz} style={{color:'#cbd5e1'}}/></button>
    </div>
  );
}

function Chip({ text, tone }) {
  const tones = {
    green: { bg:'#f0fdf4', fg:'#059669' },
    amber: { bg:'#fffbeb', fg:'#b45309' },
    red:   { bg:'#fef2f2', fg:'#dc2626' },
    slate: { bg:'#f1f5f9', fg:'#475569' },
  };
  const t = tones[tone] || tones.slate;
  return (
    <span style={{fontSize:10,fontWeight:600,padding:'2px 7px',borderRadius:5,background:t.bg,color:t.fg}}>{text}</span>
  );
}

const btnPrimary = {display:'inline-flex',alignItems:'center',gap:5,padding:'8px 14px',fontSize:13,fontWeight:600,background:'#0f172a',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontFamily:"'Outfit', sans-serif"};
const btnOutline = {display:'inline-flex',alignItems:'center',gap:4,padding:'8px 14px',fontSize:13,fontWeight:600,background:'#fff',color:'#0f172a',border:'1px solid #e5e7eb',borderRadius:10,cursor:'pointer',fontFamily:"'Outfit', sans-serif"};
const inputStyle = {width:'100%',padding:'8px 12px',fontSize:13,border:'1px solid #e5e7eb',borderRadius:8,outline:'none',fontFamily:"'Outfit', sans-serif",boxSizing:'border-box'};
const modeBtn = {flex:1,textAlign:'left',padding:'10px 12px',borderRadius:10,border:'1px solid #e5e7eb',background:'#fff',cursor:'pointer',fontFamily:"'Outfit', sans-serif",color:'#0f172a'};
const modeBtnActive = {borderColor:'#059669',background:'#f0fdf4',boxShadow:'0 0 0 1px #059669'};
const formLabel = {display:'block',fontSize:11,fontWeight:600,color:'#64748b',textTransform:'uppercase',marginBottom:4,fontFamily:"'Outfit', sans-serif"};
