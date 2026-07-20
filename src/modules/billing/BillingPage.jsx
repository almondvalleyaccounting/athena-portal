import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Download, Check, Send, Trash2, Pencil, Minimize2, Maximize2, AlertTriangle, RefreshCw, History, Ban, RotateCcw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { pushBillingItems, refreshBillingItems, fetchClientInvoices, fetchQboSettings } from '../../lib/qboApi';
import { useAuth } from '../../shell/AppShell';
import NewClientModal from '../../components/NewClientModal';
import ClientTypeAhead from '../work-planner/components/ClientTypeAhead';

const VAT_RATE = 0.20;
const STATUS_CONFIG = {
  draft: { label: 'Draft', colour: '#64748b', bg: '#f1f5f9' },
  approved: { label: 'Approved', colour: '#059669', bg: '#f0fdf4' },
  pushed: { label: 'Pushed to QBO', colour: '#0e7fe0', bg: '#eff6ff' },
  rejected: { label: 'Rejected', colour: '#dc2626', bg: '#fef2f2' },
  not_required: { label: 'Not required', colour: '#7c3aed', bg: '#f5f3ff' },
};
const SERVICES = ['Admin','Accounts Production','Corporation Tax','Self Assessment','VAT Returns','Bookkeeping','Payroll','Management Accounts','Company Secretarial','Advisory','SA302s','Accountant Certificates'];

export default function BillingPage() {
  const { profile } = useAuth();
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const [highlightActive, setHighlightActive] = useState(!!highlightId);
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
  const [dueDays, setDueDays] = useState(14);
  const [pushResults, setPushResults] = useState(null); // { summary, results } | { error }
  const [preview, setPreview] = useState(null); // dry-run plan rows
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  // Per-item billing contact (email + address), keyed by billing_item_id.
  // Seeded from the dry-run plan's resolved contact, editable before push.
  const [contacts, setContacts] = useState({});
  const [contactIndex, setContactIndex] = useState(0); // which target is being edited

  const [formClient, setFormClient] = useState('');
  // Multi-line bill editor. One client, N service lines → one QBO invoice.
  const [formLines, setFormLines] = useState([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const autoRefreshedRef = useRef(false); // only auto-refresh once per mount
  const [showNewClient, setShowNewClient] = useState(false);
  const [newClientName, setNewClientName] = useState(''); // seeds the new-client modal
  // Copy-from-past-invoice picker
  const [showInvoicePicker, setShowInvoicePicker] = useState(false);
  const [invLoading, setInvLoading] = useState(false);
  const [invError, setInvError] = useState('');
  const [clientInvoices, setClientInvoices] = useState([]);
  const [expandedInv, setExpandedInv] = useState(null);
  const [customTxn, setCustomTxn] = useState(null); // QBO custom-transaction-numbers: null=unknown

  useEffect(() => { loadData(); }, []);

  // Deep link from "Review bill" (e.g. an admin task just raised this one) —
  // make sure it's visible regardless of status, then scroll + flash it.
  useEffect(() => {
    if (!highlightId) return;
    setFilter('all');
  }, [highlightId]);

  useEffect(() => {
    if (!highlightId || loading) return;
    const scrollTimer = setTimeout(() => {
      document.getElementById(`billing-item-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    const fadeTimer = setTimeout(() => setHighlightActive(false), 3000);
    return () => { clearTimeout(scrollTimer); clearTimeout(fadeTimer); };
  }, [highlightId, loading]);

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
      // On first load, silently re-confirm invoice number + sent status from
      // QBO for pushed bills that don't have them yet (or aren't sent yet).
      if (!autoRefreshedRef.current) {
        autoRefreshedRef.current = true;
        autoRefreshPushed(bills || []);
        // Confirm whether QBO's "Custom transaction numbers" is on — that's
        // what leaves API-pushed invoices without a number.
        fetchQboSettings().then((r) => setCustomTxn(r?.custom_txn_numbers ?? null)).catch(() => {});
      }
    } catch (e) { console.error('[Billing] load error:', e); }
    setLoading(false);
  };

  // Fire-and-forget QBO re-confirm for pushed rows missing a doc number or
  // not yet shown as sent. Updates items in place when it returns.
  const autoRefreshPushed = async (bills) => {
    const need = (bills || []).filter((i) => i.status === 'pushed' && (!i.qbo_doc_number || i.qbo_email_status !== 'EmailSent'));
    if (!need.length) return;
    try {
      await refreshBillingItems(need.map((i) => i.id), profile?.id);
      const { data } = await supabase.from('billing_items').select('*').order('created_at', { ascending: false });
      if (data) setItems(data);
    } catch (e) { console.error('[Billing] auto-refresh error:', e); }
  };

  const handleRefreshQbo = async () => {
    setRefreshing(true);
    try {
      await refreshBillingItems([], profile?.id); // all pushed
      const { data } = await supabase.from('billing_items').select('*').order('created_at', { ascending: false });
      if (data) setItems(data);
    } catch (e) { console.error('[Billing] refresh error:', e); }
    setRefreshing(false);
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
  const resetForm = () => { setFormClient(''); setFormLines([blankLine()]); };

  // Multi-line editor helpers. Net drives VAT (auto 20%) unless the user
  // types a VAT figure (vatManual); gross is always net + VAT.
  const changeLineField = (idx, key, value) => setFormLines((prev) => prev.map((l, i) => i === idx ? { ...l, [key]: value } : l));
  const changeLineNet = (idx, value) => setFormLines((prev) => prev.map((l, i) => {
    if (i !== idx) return l;
    const net = parseFloat(value) || 0;
    if (l.vatManual) { const vat = parseFloat(l.vat) || 0; return { ...l, net: value, gross: value === '' ? '' : (net + vat).toFixed(2) }; }
    const vat = Math.round(net * VAT_RATE * 100) / 100;
    return { ...l, net: value, vat: value === '' ? '' : vat.toFixed(2), gross: value === '' ? '' : (net + vat).toFixed(2) };
  }));
  const changeLineVat = (idx, value) => setFormLines((prev) => prev.map((l, i) => {
    if (i !== idx) return l;
    const net = parseFloat(l.net) || 0; const vat = parseFloat(value) || 0;
    return { ...l, vat: value, vatManual: true, gross: (net + vat).toFixed(2) };
  }));
  const addLine = () => setFormLines((prev) => [...prev, blankLine()]);
  const removeLine = (idx) => setFormLines((prev) => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);
  const formTotals = formLines.reduce((t, l) => ({
    net: t.net + (parseFloat(l.net) || 0), vat: t.vat + (parseFloat(l.vat) || 0), gross: t.gross + (parseFloat(l.gross) || 0),
  }), { net: 0, vat: 0, gross: 0 });
  const formCanSubmit = !!formClient && formLines.some((l) => l.service && l.net !== '');

  // Create a new client inline (NewClientModal handles the form; we own the
  // insert). Adds it to the dropdown and selects it for this bill.
  const handleCreateClient = async (fields) => {
    const { data, error } = await supabase.from('entities').insert(fields).select('id, name').single();
    if (error) throw error;
    setEntities((prev) => [...prev, { id: data.id, name: data.name }].sort((a, b) => (a.name || '').localeCompare(b.name || '')));
    setFormClient(data.id);
    return data;
  };

  // Pull the selected client's last 24 months of QBO invoices.
  const openInvoicePicker = async () => {
    if (!formClient) return;
    setShowInvoicePicker(true);
    setInvLoading(true); setInvError(''); setClientInvoices([]); setExpandedInv(null);
    try {
      const res = await fetchClientInvoices(formClient);
      if (res?.customer_found === false) setInvError('This client has no matching QuickBooks customer yet.');
      setClientInvoices(res?.invoices || []);
    } catch (e) { setInvError(e.message || 'Could not load invoices from QuickBooks'); }
    setInvLoading(false);
  };

  // Copy a past invoice's lines into the multi-line editor (review before save).
  const copyInvoiceToForm = (inv) => {
    const ls = (inv.lines || []).map((l) => {
      const net = Number(l.amount) || 0;
      const vat = Math.round(net * VAT_RATE * 100) / 100;
      return {
        service: l.service || '', description: l.description || '',
        net: net ? String(net) : '', vat: net ? vat.toFixed(2) : '', gross: net ? (net + vat).toFixed(2) : '',
        vatManual: false,
      };
    });
    setFormLines(ls.length ? ls : [blankLine()]);
    setShowAdd(true); setEditingId(null);
    setShowInvoicePicker(false);
  };

  // Per-item billing-contact helpers (push-confirm modal).
  const contactOf = (id) => contacts[id] || { email: '', line1: '', line2: '', city: '', postcode: '' };
  const setContact = (id, patch) => setContacts((prev) => ({ ...prev, [id]: { ...contactOf(id), ...patch } }));
  const isContactReady = (id) => { const c = contactOf(id); return !!(c.email?.trim() && c.line1?.trim() && c.postcode?.trim()); };

  // Turn the editor rows into the stored line array + invoice totals + a
  // short `service` summary for the list view.
  const buildLinesPayload = () => {
    const lines = formLines
      .filter((l) => l.service && l.net !== '')
      .map((l) => {
        const net = parseFloat(l.net) || 0;
        const vat = l.vat !== '' ? (parseFloat(l.vat) || 0) : Math.round(net * VAT_RATE * 100) / 100;
        const gross = Math.round((net + vat) * 100) / 100;
        return { service: l.service, description: l.description.trim() || null, net, vat, gross };
      });
    const totals = lines.reduce((t, l) => ({ net: t.net + l.net, vat: t.vat + l.vat, gross: t.gross + l.gross }), { net: 0, vat: 0, gross: 0 });
    const summary = lines.length === 1 ? lines[0].service : `${lines[0].service} +${lines.length - 1} more`;
    return { lines, totals, summary };
  };

  const handleAdd = async () => {
    if (!formCanSubmit) return;
    setSaving(true);
    const { lines, totals, summary } = buildLinesPayload();
    try {
      await supabase.from('billing_items').insert({
        entity_id: formClient, service: summary, description: null,
        net_amount: totals.net, vat_amount: totals.vat, gross_amount: totals.gross,
        lines, status: 'draft', created_by: profile?.id,
      });
      resetForm(); setShowAdd(false); await loadData();
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const handleUpdate = async (item) => {
    if (!formCanSubmit) return;
    setSaving(true);
    const { lines, totals, summary } = buildLinesPayload();
    try {
      await supabase.from('billing_items').update({
        entity_id: formClient, service: summary, description: null,
        net_amount: totals.net, vat_amount: totals.vat, gross_amount: totals.gross,
        lines,
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
  // Email + address (line 1 + postcode) are mandatory before any push.
  const notReadyTargets = pushTargets.filter((i) => !isContactReady(i.id));
  const allContactsReady = pushTargets.length > 0 && notReadyTargets.length === 0;

  const handleBatchPush = async () => {
    setPushing(true);
    setPushResults(null);
    try {
      // Save each chosen billing contact to its client record first, so the
      // push reads it (the edge function resolves Athena fields first) and
      // it's on file for any retry. One row per entity (last edit wins).
      const byEntity = {};
      for (const it of pushTargets) { if (it.entity_id) byEntity[it.entity_id] = contactOf(it.id); }
      await Promise.all(Object.entries(byEntity).map(([entId, c]) =>
        supabase.from('entities').update({
          billing_email: c.email.trim() || null,
          billing_line1: c.line1.trim() || null,
          billing_line2: c.line2.trim() || null,
          billing_city: c.city.trim() || null,
          billing_postcode: c.postcode.trim() || null,
        }).eq('id', entId)
      ));

      const result = await pushBillingItems(
        pushTargets.map((i) => i.id),
        sendMode === 'send',
        profile?.id,
        false,
        Number(dueDays) >= 0 ? Number(dueDays) : 14,
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
    if (!showPushConfirm) { setPreview(null); setPreviewError(null); setContacts({}); setContactIndex(0); return; }
    let cancelled = false;
    const ids = pushTargets.map((i) => i.id);
    if (ids.length === 0) return;
    setPreviewLoading(true); setPreviewError(null);
    pushBillingItems(ids, true, profile?.id, true)
      .then((res) => {
        if (cancelled) return;
        const plan = res?.plan || [];
        setPreview(plan);
        // Seed each item's contact from the resolved dry-run values
        // (Athena → QBO → recurring template → group member). Don't clobber
        // anything the user has already edited this session.
        setContacts((prev) => {
          const next = { ...prev };
          for (const p of plan) {
            if (next[p.billing_item_id]) continue;
            const a = p.address || {};
            next[p.billing_item_id] = {
              email: p.email || '',
              line1: a.Line1 || '', line2: a.Line2 || '', city: a.City || '', postcode: a.PostalCode || '',
            };
          }
          return next;
        });
      })
      .catch((e) => { if (!cancelled) setPreviewError(e.message || 'Could not load preview'); })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [showPushConfirm]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = (item) => {
    setEditingId(item.id); setShowAdd(false);
    setFormClient(item.entity_id || '');
    // Load the stored lines, or build a single line from the legacy fields.
    const ls = Array.isArray(item.lines) && item.lines.length
      ? item.lines.map((l) => ({
          service: l.service || '', description: l.description || '',
          net: l.net != null ? String(l.net) : '', vat: l.vat != null ? String(l.vat) : '',
          gross: l.gross != null ? String(l.gross) : '', vatManual: true,
        }))
      : [{
          service: item.service || '', description: item.description || '',
          net: String(item.net_amount || ''), vat: String(item.vat_amount || ''),
          gross: String(item.gross_amount || ''), vatManual: true,
        }];
    setFormLines(ls.length ? ls : [blankLine()]);
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
      {/* Client (one per bill → one invoice). Type-to-filter + A-Z jumper;
          the inline "+ Add" routes to the New Client modal. */}
      <div style={{marginBottom:14}}>
        <label style={formLabel}>Client *</label>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          <div style={{flex:'1 1 280px',maxWidth:340}}>
            <ClientTypeAhead
              entityList={entities}
              value={formClient}
              onChange={(id)=>setFormClient(id)}
              onAddNew={(name)=>{ setNewClientName(name || ''); setShowNewClient(true); return null; }}
            />
          </div>
          <button onClick={()=>{setNewClientName('');setShowNewClient(true);}} style={{...btnOutline,gap:4}} title="Create a new client"><Plus size={14}/> New client</button>
          <button onClick={openInvoicePicker} disabled={!formClient} style={{...btnOutline,gap:4,opacity:formClient?1:0.4,cursor:formClient?'pointer':'not-allowed'}} title="Copy a past QBO invoice into this bill"><History size={14}/> Copy from past invoice</button>
        </div>
      </div>

      {/* Line items header */}
      <div style={{display:'grid',gridTemplateColumns:LINE_COLS,gap:8,marginBottom:4,paddingRight:2}}>
        <span style={formLabel}>Service *</span><span style={formLabel}>Description</span>
        <span style={formLabel}>Net (£) *</span><span style={formLabel}>VAT (£)</span><span style={formLabel}>Gross (£)</span><span/>
      </div>
      {formLines.map((l,idx)=>(
        <div key={idx} style={{display:'grid',gridTemplateColumns:LINE_COLS,gap:8,marginBottom:6,alignItems:'flex-start'}}>
          <select value={l.service} onChange={(e)=>changeLineField(idx,'service',e.target.value)} style={inputStyle}>
            <option value="">Select...</option>
            {/* Include a copied QBO service name even if it isn't in our list. */}
            {l.service && !SERVICES.includes(l.service) && <option value={l.service}>{l.service}</option>}
            {SERVICES.map((s)=><option key={s} value={s}>{s}</option>)}
          </select>
          {/* Textarea so multi-line QBO descriptions keep their line breaks. */}
          <textarea value={l.description} onChange={(e)=>changeLineField(idx,'description',e.target.value)} placeholder="Optional..." rows={2} style={{...inputStyle,resize:'vertical',minHeight:38,lineHeight:1.4}}/>
          <input type="number" step="0.01" value={l.net} placeholder="0.00" style={inputStyle} onChange={(e)=>changeLineNet(idx,e.target.value)}/>
          <input type="number" step="0.01" value={l.vat} placeholder="0.00" style={inputStyle} onChange={(e)=>changeLineVat(idx,e.target.value)}/>
          <input value={l.gross} placeholder="0.00" style={{...inputStyle,background:'#f8fafc'}} readOnly/>
          <button onClick={()=>removeLine(idx)} disabled={formLines.length===1} title="Remove line"
            style={{background:'none',border:'none',cursor:formLines.length===1?'default':'pointer',padding:4,opacity:formLines.length===1?0.3:1,display:'inline-flex'}}>
            <Trash2 size={15} style={{color:'#94a3b8'}}/>
          </button>
        </div>
      ))}
      <button onClick={addLine} style={{...btnOutline,gap:5,marginTop:2}}><Plus size={14}/> Add line</button>

      {/* Totals + actions */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:16,borderTop:'1px solid #f1f5f9',paddingTop:12}}>
        <div style={{fontSize:13,color:'#64748b'}}>
          Total: <b style={{color:'#0f172a'}}>{fmt(formTotals.net)}</b> net · {fmt(formTotals.vat)} VAT · <b style={{color:'#0e7fe0'}}>{fmt(formTotals.gross)}</b> gross
        </div>
        <div style={{display:'flex',gap:6}}>
          <button onClick={onSubmit} disabled={!formCanSubmit||saving} style={{...btnPrimary,opacity:(!formCanSubmit||saving)?0.4:1}}>{saving?'Saving...':submitLabel}</button>
          <button onClick={onCancel} style={btnOutline}>Cancel</button>
        </div>
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
          {items.some((i)=>i.status==='pushed') && (
            <button onClick={handleRefreshQbo} disabled={refreshing} style={{...btnOutline,gap:5,opacity:refreshing?0.5:1}} title="Re-confirm invoice numbers + sent status from QuickBooks">
              <RefreshCw size={14}/> {refreshing?'Refreshing…':'Refresh from QBO'}
            </button>
          )}
          {filtered.length>0 && <button onClick={handleExport} style={{...btnOutline,gap:5}}><Download size={14}/> Export{selected.size>0?` (${selected.size})`:''}</button>}
          <button onClick={()=>{setShowAdd(!showAdd);setEditingId(null);resetForm();}} style={btnPrimary}><Plus size={14}/> New Item</button>
        </div>
      </div>

      {/* QBO numbering notice — confirmed via check_settings on load. */}
      {(() => {
        const blanks = items.filter((i)=>i.status==='pushed' && !i.qbo_doc_number);
        if (blanks.length === 0) return null;
        // Setting still on → invoices will keep coming through un-numbered.
        if (customTxn === true) return (
          <div style={{display:'flex',gap:10,alignItems:'flex-start',background:'#fffbeb',border:'1px solid #fde68a',borderRadius:10,padding:'12px 16px',marginBottom:16,fontSize:13,color:'#92400e',lineHeight:1.5}}>
            <AlertTriangle size={16} style={{color:'#d97706',flexShrink:0,marginTop:1}}/>
            <div>
              <b>QuickBooks isn&apos;t numbering these invoices.</b> Your QBO company has &ldquo;Custom transaction numbers&rdquo; switched on, so invoices Athena pushes go in without a number. Turn it off in QBO → <i>Account &amp; Settings → Sales → Sales form content → &ldquo;Custom transaction numbers&rdquo;</i>, then use the button here to assign numbers.
            </div>
          </div>
        );
        // Setting off (or unknown) but some bills are still blank — these
        // were created before auto-numbering. QBO only numbers on create,
        // not via the API on update, so they must be saved once in QBO.
        return (
          <div style={{display:'flex',gap:10,alignItems:'flex-start',background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:10,padding:'12px 16px',marginBottom:16,fontSize:13,color:'#1e40af',lineHeight:1.5}}>
            <AlertTriangle size={16} style={{color:'#0e7fe0',flexShrink:0,marginTop:1}}/>
            <div>{blanks.length} pushed invoice{blanks.length!==1?'s':''} {blanks.length!==1?'have':'has'} no QuickBooks number (created before auto-numbering). Open {blanks.length!==1?'each':'it'} in QuickBooks and click <b>Save</b> to assign the number, then use <b>Refresh from QBO</b> here to pull it in.</div>
          </div>
        );
      })()}

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
            const isHighlighted = highlightActive && item.id === highlightId;

            if (compact) return (
              <div key={item.id} id={`billing-item-${item.id}`} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 12px',background:isHighlighted?'#eff6ff':isSelected?'#eff6ff':'#fff',borderRadius:8,border:`1px solid ${isSelected?'#0e7fe0':'#e5e7eb'}`,borderLeft:`3px solid ${sc.colour}`,fontSize:12,boxShadow:isHighlighted?'0 0 0 3px rgba(14,127,224,0.35)':'none',transition:'box-shadow 0.3s ease'}}>
                <input type="checkbox" checked={isSelected} onChange={()=>toggleSelect(item.id)} style={{width:13,height:13,cursor:'pointer',accentColor:'#0e7fe0',flexShrink:0}}/>
                <span style={{fontWeight:500,color:'#0f172a',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{clientName} — {item.service}</span>
                <span style={{fontWeight:600,color:'#0f172a',flexShrink:0}}>{fmt(item.gross_amount)}</span>
                <span style={{fontSize:10,fontWeight:600,color:sc.colour,background:sc.bg,padding:'2px 6px',borderRadius:4,flexShrink:0}}>{sc.label}</span>
                <QboInvoiceTag item={item}/>
                <span style={{fontSize:10,color:'#94a3b8',flexShrink:0}}>{addedBy} · {dateStr}</span>
                <ActionButtons item={item} onEdit={()=>startEdit(item)} onDelete={()=>handleDelete(item)} onStatus={handleStatusChange} compact/>
              </div>
            );

            return (
              <div key={item.id} id={`billing-item-${item.id}`} style={{display:'flex',alignItems:'flex-start',gap:12,padding:'14px 18px',background:isSelected?'#eff6ff':'#fff',borderRadius:12,border:`1px solid ${isSelected?'#0e7fe0':'#e5e7eb'}`,borderLeft:`3px solid ${sc.colour}`,boxShadow:isHighlighted?'0 0 0 3px rgba(14,127,224,0.35)':'none',transition:'box-shadow 0.3s ease'}}>
                <input type="checkbox" checked={isSelected} onChange={()=>toggleSelect(item.id)} style={{width:14,height:14,cursor:'pointer',accentColor:'#0e7fe0',marginTop:3,flexShrink:0}}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:500,color:'#0f172a',marginBottom:2}}>{clientName} — {item.service}</div>
                  {item.description && <div style={{fontSize:12,color:'#64748b'}}>{item.description}</div>}
                  <div style={{fontSize:11,color:'#94a3b8',marginTop:4,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    <span style={{fontSize:10,fontWeight:600,color:sc.colour,background:sc.bg,padding:'2px 8px',borderRadius:6}}>{sc.label}</span>
                    <QboInvoiceTag item={item}/>
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
          <div onClick={(e)=>e.stopPropagation()} style={{background:'#fff',borderRadius:16,padding:'32px',maxWidth:920,width:'100%',maxHeight:'90vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.15)'}}>
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

            {/* Payment terms */}
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:16}}>
              <label style={{fontSize:13,color:'#475569',fontWeight:500}}>Due in</label>
              <input
                type="number"
                min="0"
                value={dueDays}
                onChange={(e)=>setDueDays(e.target.value)}
                style={{width:70,padding:'6px 8px',fontSize:13,border:'1px solid #e5e7eb',borderRadius:8,fontFamily:"'Outfit', sans-serif"}}
              />
              <span style={{fontSize:13,color:'#64748b'}}>days from invoice date</span>
            </div>

            {/* Billing contact (mandatory: email + address). Seeded from QBO
                via the dry-run, editable per item with a navigator. */}
            {pushTargets.length > 0 && (() => {
              const curTarget = pushTargets[Math.min(contactIndex, pushTargets.length - 1)];
              if (!curTarget) return null;
              const id = curTarget.id;
              const cc = contactOf(id);
              const cp = preview?.find((r) => r.billing_item_id === id);
              const name = entityMap[curTarget.entity_id]?.name || 'Unknown';
              return (
                <div style={{background:'#f8fafc',borderRadius:10,border:'1px solid #e5e7eb',padding:'14px 16px',marginBottom:16}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                    <span style={{fontSize:11,fontWeight:700,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.04em'}}>Billing contact</span>
                    {pushTargets.length>1 && (
                      <div style={{display:'flex',alignItems:'center',gap:8,fontSize:12,color:'#64748b'}}>
                        <button onClick={()=>setContactIndex((i)=>(i-1+pushTargets.length)%pushTargets.length)} disabled={pushing} style={navBtn} title="Previous">‹</button>
                        <span>{Math.min(contactIndex,pushTargets.length-1)+1} of {pushTargets.length}</span>
                        <button onClick={()=>setContactIndex((i)=>(i+1)%pushTargets.length)} disabled={pushing} style={navBtn} title="Next">›</button>
                      </div>
                    )}
                  </div>
                  <div style={{fontSize:13,fontWeight:600,color:'#0f172a',marginBottom:8}}>{name} — {curTarget.service}</div>

                  <label style={formLabel}>Email *</label>
                  {cp?.email_options?.length>0 && (
                    <select value="" onChange={(e)=>{ if(e.target.value) setContact(id,{email:e.target.value}); }} disabled={pushing} style={{...inputStyle,marginBottom:6,color:'#64748b'}}>
                      <option value="">Pick a known email…</option>
                      {cp.email_options.map((opt)=><option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  )}
                  <input type="email" value={cc.email} onChange={(e)=>setContact(id,{email:e.target.value})} disabled={pushing} placeholder="billing@example.com" style={{...inputStyle,marginBottom:10}}/>

                  <label style={formLabel}>Billing address *{!isContactReady(id) && cp?.address_hint && <span style={{color:'#b45309',fontWeight:400,textTransform:'none'}}> · on file: {cp.address_hint}</span>}</label>
                  {cp?.address_options?.length>0 && (
                    <select value="" onChange={(e)=>{ const a=cp.address_options[Number(e.target.value)]?.addr; if(a) setContact(id,{line1:a.Line1||'',line2:a.Line2||'',city:a.City||'',postcode:a.PostalCode||''}); }} disabled={pushing} style={{...inputStyle,marginBottom:6,color:'#64748b'}}>
                      <option value="">Pick a known address…</option>
                      {cp.address_options.map((o,i)=><option key={i} value={i}>{o.label}</option>)}
                    </select>
                  )}
                  <input value={cc.line1} onChange={(e)=>setContact(id,{line1:e.target.value})} disabled={pushing} placeholder="Address line 1" style={{...inputStyle,marginBottom:6}}/>
                  <input value={cc.line2} onChange={(e)=>setContact(id,{line2:e.target.value})} disabled={pushing} placeholder="Address line 2 (optional)" style={{...inputStyle,marginBottom:6}}/>
                  <div style={{display:'flex',gap:6}}>
                    <input value={cc.city} onChange={(e)=>setContact(id,{city:e.target.value})} disabled={pushing} placeholder="Town/City" style={{...inputStyle,flex:1}}/>
                    <input value={cc.postcode} onChange={(e)=>setContact(id,{postcode:e.target.value})} disabled={pushing} placeholder="Postcode" style={{...inputStyle,width:120}}/>
                  </div>
                  {pushTargets.length>1 && (
                    <button onClick={()=>{ const src=contactOf(id); setContacts((prev)=>{ const next={...prev}; pushTargets.forEach((t)=>{ next[t.id]={...contactOf(t.id),line1:src.line1,line2:src.line2,city:src.city,postcode:src.postcode}; }); return next; }); }} disabled={pushing} style={{marginTop:8,fontSize:12,color:'#0e7fe0',background:'none',border:'none',cursor:'pointer',padding:0,fontFamily:"'Outfit', sans-serif"}}>
                      Apply this address to all
                    </button>
                  )}
                  {!isContactReady(id) && <p style={{fontSize:11,color:'#b45309',marginTop:8}}>Needs an email and address (line 1 + postcode) before pushing.</p>}
                </div>
              );
            })()}

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
            <div style={{background:'#f8fafc',borderRadius:8,padding:'8px 14px',marginBottom:20,maxHeight:380,overflowY:'auto'}}>
              {previewLoading && <div style={{fontSize:12,color:'#94a3b8',padding:'4px 0'}}>Checking QuickBooks…</div>}
              {previewError && <div style={{fontSize:12,color:'#b91c1c',padding:'4px 0'}}>Couldn&apos;t load preview: {previewError}</div>}
              {/* Header */}
              <div style={{display:'grid',gridTemplateColumns:INVOICE_COLS,gap:10,padding:'4px 0',fontSize:10,fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.04em',borderBottom:'1px solid #e5e7eb'}}>
                <span>Client</span><span>Service</span><span>Type</span><span>Customer</span><span>Send</span>
                <span style={{textAlign:'right'}}>Net</span><span style={{textAlign:'right'}}>VAT</span><span style={{textAlign:'right'}}>Gross</span>
              </div>
              {pushTargets.map((item,idx)=>{
                const p = preview?.find((r)=>r.billing_item_id===item.id);
                // Send/ready derive from the LIVE edited contact, not the
                // pre-edit dry-run, so the row reflects gaps the user is fixing.
                const cc = contactOf(item.id);
                const liveEmail = cc.email?.trim();
                const ready = isContactReady(item.id);
                const willSend = sendMode==='send' && !!liveEmail;
                const sendText = willSend ? `Now → ${liveEmail}`
                  : (sendMode==='send' && !liveEmail) ? 'Later (no email)'
                  : 'Later (manual)';
                const sendColor = willSend ? '#059669' : (sendMode==='send' && !liveEmail) ? '#b45309' : '#64748b';
                const isCurrent = Math.min(contactIndex,pushTargets.length-1)===idx;
                return (
                  <div key={item.id} onClick={()=>setContactIndex(idx)} style={{display:'grid',gridTemplateColumns:INVOICE_COLS,gap:10,alignItems:'center',padding:'7px 4px',borderBottom:'1px solid #f1f5f9',fontSize:12,cursor:'pointer',background:isCurrent?'#eff6ff':'transparent',borderRadius:6}}>
                    <span style={ellip} title={entityMap[item.entity_id]?.name}>{!ready && <span style={{color:'#b45309'}} title="Needs email + address">⚠ </span>}{entityMap[item.entity_id]?.name||'—'}</span>
                    <span style={{...ellip,color:'#475569'}} title={item.description||item.service}>{item.service}</span>
                    <span style={{color:'#64748b'}}>One-off</span>
                    <span style={{color:p?.customer_action==='create'?'#b45309':'#475569',fontWeight:500}}>{!p?'…':p.customer_action==='create'?'New':'Existing'}</span>
                    <span style={{...ellip,color:sendColor}} title={liveEmail||sendText}>{sendText}</span>
                    <span style={{textAlign:'right',fontFamily:'monospace',color:'#64748b'}}>{fmt(item.net_amount)}</span>
                    <span style={{textAlign:'right',fontFamily:'monospace',color:'#64748b'}}>{fmt(item.vat_amount)}</span>
                    <span style={{textAlign:'right',fontFamily:'monospace',fontWeight:600,color:'#0f172a'}}>{fmt(item.gross_amount)}</span>
                  </div>
                );
              })}
              {/* Totals */}
              <div style={{display:'grid',gridTemplateColumns:INVOICE_COLS,gap:10,padding:'8px 0 0',borderTop:'2px solid #e5e7eb',marginTop:2,fontSize:13,fontWeight:700}}>
                <span style={{gridColumn:'1 / 6'}}>Total ({pushTargets.length})</span>
                <span style={{textAlign:'right',fontFamily:'monospace',color:'#64748b'}}>{fmt(pushTargets.reduce((s,i)=>s+(i.net_amount||0),0))}</span>
                <span style={{textAlign:'right',fontFamily:'monospace',color:'#64748b'}}>{fmt(pushTargets.reduce((s,i)=>s+(i.vat_amount||0),0))}</span>
                <span style={{textAlign:'right',fontFamily:'monospace',color:'#0e7fe0'}}>{fmt(pushTargets.reduce((s,i)=>s+(i.gross_amount||0),0))}</span>
              </div>
            </div>
            {!allContactsReady && pushTargets.length>0 && !previewLoading && (
              <p style={{fontSize:12,color:'#b45309',marginBottom:8}}>
                {notReadyTargets.length} {notReadyTargets.length===1?'item needs':'items need'} an email + address (line 1 + postcode) before you can push.
              </p>
            )}
            <div style={{display:'flex',gap:10}}>
              <button onClick={()=>{setShowPushConfirm(false);setPushResults(null);}} style={{...btnOutline,flex:1}}>{pushResults && !pushResults.error ? 'Close' : 'Cancel'}</button>
              <button onClick={handleBatchPush} disabled={pushing || !allContactsReady} style={{...btnPrimary,flex:1,background:'#059669',justifyContent:'center',opacity:(pushing||!allContactsReady)?0.5:1}}>
                {pushing?'Pushing...':(sendMode==='send'?'Create & send':'Create drafts')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create a new client inline */}
      <NewClientModal open={showNewClient} initialName={newClientName} onClose={()=>{setShowNewClient(false);setNewClientName('');}} onSave={handleCreateClient}/>

      {/* Copy from a past QBO invoice (last 24 months) */}
      {showInvoicePicker && (
        <div onClick={()=>setShowInvoicePicker(false)} style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
          <div onClick={(e)=>e.stopPropagation()} style={{background:'#fff',borderRadius:16,padding:'28px',maxWidth:720,width:'100%',maxHeight:'85vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.15)'}}>
            <h2 style={{fontFamily:"'Playfair Display', serif",fontSize:20,fontWeight:500,color:'#0f172a',margin:'0 0 4px'}}>Copy from a past invoice</h2>
            <p style={{fontSize:13,color:'#64748b',marginBottom:16}}>{entityMap[formClient]?.name||'Client'} · last 24 months from QuickBooks</p>
            {invLoading && <p style={{fontSize:13,color:'#94a3b8',padding:'24px 0',textAlign:'center'}}>Loading invoices from QuickBooks…</p>}
            {invError && <div style={{fontSize:12,color:'#b91c1c',background:'#fef2f2',border:'1px solid #fecaca',borderRadius:8,padding:'10px 12px',marginBottom:12}}>{invError}</div>}
            {!invLoading && !invError && clientInvoices.length===0 && <p style={{fontSize:13,color:'#94a3b8',padding:'24px 0',textAlign:'center'}}>No invoices in the last 24 months.</p>}
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {clientInvoices.map((inv)=>{
                const open = expandedInv===inv.id;
                return (
                  <div key={inv.id} style={{border:'1px solid #e5e7eb',borderRadius:10,overflow:'hidden'}}>
                    <div onClick={()=>setExpandedInv(open?null:inv.id)} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',cursor:'pointer',background:open?'#f8fafc':'#fff'}}>
                      <span style={{fontSize:12,color:'#94a3b8',width:14}}>{open?'▾':'▸'}</span>
                      <span style={{fontSize:13,fontWeight:600,color:'#0f172a',width:96}}>{inv.doc_number?`INV #${inv.doc_number}`:'—'}</span>
                      <span style={{fontSize:12,color:'#64748b',flex:1}}>{inv.txn_date} · {inv.lines.length} line{inv.lines.length!==1?'s':''}</span>
                      <span style={{fontSize:13,fontWeight:600,color:'#0f172a'}}>{fmt(inv.total_amt)}</span>
                      <button onClick={(e)=>{e.stopPropagation();copyInvoiceToForm(inv);}} style={{...btnPrimary,padding:'6px 10px',fontSize:12,gap:4}}><Plus size={13}/> Copy</button>
                    </div>
                    {open && (
                      <div style={{borderTop:'1px solid #f1f5f9',padding:'8px 14px',background:'#fafafa'}}>
                        {inv.lines.map((l,i)=>(
                          <div key={i} style={{display:'flex',gap:10,fontSize:12,padding:'4px 0',borderBottom:i<inv.lines.length-1?'1px solid #f1f5f9':'none'}}>
                            <span style={{fontWeight:500,color:'#0f172a',minWidth:150}}>{l.service||'—'}</span>
                            <span style={{color:'#64748b',flex:1,whiteSpace:'pre-line'}}>{l.description||''}</span>
                            <span style={{fontFamily:'monospace',color:'#0f172a'}}>{fmt(l.amount)}</span>
                          </div>
                        ))}
                        {inv.lines.length===0 && <p style={{fontSize:12,color:'#94a3b8',padding:'4px 0'}}>No service lines on this invoice.</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{display:'flex',justifyContent:'flex-end',marginTop:16}}>
              <button onClick={()=>setShowInvoicePicker(false)} style={btnOutline}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Invoice number + real send status, confirmed back from QBO. Pushed rows
// only. EmailSent → green "Sent"; NeedToSend → amber "Not sent"; otherwise
// grey "Draft".
function QboInvoiceTag({ item }) {
  if (item.status !== 'pushed') return null;
  const es = item.qbo_email_status;
  const tone = es === 'EmailSent' ? { c: '#15803d', b: '#f0fdf4', t: 'Sent' }
    : es === 'NeedToSend' ? { c: '#b45309', b: '#fffbeb', t: 'Not sent' }
    : { c: '#64748b', b: '#f1f5f9', t: 'Draft' };
  return (
    <>
      {item.qbo_doc_number
        ? <span style={{ fontSize: 10, fontWeight: 600, color: '#0e7fe0', background: '#eff6ff', padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>INV #{item.qbo_doc_number}</span>
        : <span title="No invoice number in QuickBooks — likely 'Custom transaction numbers' is on. See the banner above." style={{ fontSize: 10, fontWeight: 600, color: '#b45309', background: '#fffbeb', padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>no #</span>}
      <span style={{ fontSize: 10, fontWeight: 600, color: tone.c, background: tone.b, padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>{tone.t}</span>
    </>
  );
}

function ActionButtons({ item, onEdit, onDelete, onStatus, compact }) {
  const s = item.status;
  const sz = compact?12:14;
  const b = {background:'none',border:'none',cursor:'pointer',padding:compact?2:4,borderRadius:4,display:'inline-flex',alignItems:'center',transition:'all 0.12s'};
  return (
    <div style={{display:'flex',gap:compact?3:5,alignItems:'center',flexShrink:0}}>
      {/* Approve — solid green so it's unmissable (was a faint grey tick). */}
      {s==='draft' && (
        <button onClick={()=>onStatus(item,'approved')} title="Approve"
          style={{display:'inline-flex',alignItems:'center',gap:4,background:'#059669',color:'#fff',border:'none',borderRadius:6,cursor:'pointer',padding:compact?'2px 7px':'5px 10px',fontSize:compact?10:12,fontWeight:600,fontFamily:"'Outfit', sans-serif"}}>
          <Check size={sz} strokeWidth={3}/>{!compact && 'Approve'}
        </button>
      )}
      {(s==='draft'||s==='approved') && <button onClick={()=>onStatus(item,'not_required')} style={b} title="Mark not required"><Ban size={sz} style={{color:'#cbd5e1'}}/></button>}
      {s==='not_required' && <button onClick={()=>onStatus(item,'draft')} style={b} title="Back to draft"><RotateCcw size={sz} style={{color:'#94a3b8'}}/></button>}
      {s!=='pushed' && <button onClick={onEdit} style={b} title="Edit"><Pencil size={sz} style={{color:'#cbd5e1'}}/></button>}
      <button onClick={onDelete} style={b} title="Delete"><Trash2 size={sz} style={{color:'#cbd5e1'}}/></button>
    </div>
  );
}

const btnPrimary ={display:'inline-flex',alignItems:'center',gap:5,padding:'8px 14px',fontSize:13,fontWeight:600,background:'#0f172a',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontFamily:"'Outfit', sans-serif"};
const btnOutline = {display:'inline-flex',alignItems:'center',gap:4,padding:'8px 14px',fontSize:13,fontWeight:600,background:'#fff',color:'#0f172a',border:'1px solid #e5e7eb',borderRadius:10,cursor:'pointer',fontFamily:"'Outfit', sans-serif"};
const inputStyle = {width:'100%',padding:'8px 12px',fontSize:13,border:'1px solid #e5e7eb',borderRadius:8,outline:'none',fontFamily:"'Outfit', sans-serif",boxSizing:'border-box'};
const modeBtn = {flex:1,textAlign:'left',padding:'10px 12px',borderRadius:10,border:'1px solid #e5e7eb',background:'#fff',cursor:'pointer',fontFamily:"'Outfit', sans-serif",color:'#0f172a'};
const navBtn = {padding:'2px 8px',borderRadius:6,border:'1px solid #e5e7eb',background:'#fff',cursor:'pointer',fontFamily:"'Outfit', sans-serif",fontSize:13,color:'#475569'};
const INVOICE_COLS = '1.5fr 1.1fr 0.6fr 0.8fr 1.8fr 0.8fr 0.7fr 0.85fr';
const LINE_COLS = '1.3fr 1.8fr 0.9fr 0.9fr 0.9fr 32px';
// A fresh, empty editor line.
function blankLine() { return { service: '', description: '', net: '', vat: '', gross: '', vatManual: false }; }
const ellip = { overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' };
const modeBtnActive = {borderColor:'#059669',background:'#f0fdf4',boxShadow:'0 0 0 1px #059669'};
const formLabel = {display:'block',fontSize:11,fontWeight:600,color:'#64748b',textTransform:'uppercase',marginBottom:4,fontFamily:"'Outfit', sans-serif"};
