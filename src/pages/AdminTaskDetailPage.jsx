import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, Receipt, Flame, Send, ExternalLink } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../shell/AppShell';
import ClientTypeAhead from '../modules/work-planner/components/ClientTypeAhead';
import { insertEntity } from '../modules/work-planner/lib/supabaseQueries';
import NewClientModal from '../components/NewClientModal';
import ServicePicker from '../modules/billing/ServicePicker';
import { fetchAdhocServices } from '../modules/billing/billingServices';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '18px 20px' };
const label = { fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 5 };
const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '8px 12px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 8, fontFamily: font, outline: 'none' };
const VAT_RATE = 0.20;
const STAGES = [['draft', 'Draft'], ['bill_hold', 'Bill & Hold'], ['billed', 'Billed'], ['todo', 'To Do']];

function fmtNoteTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/*
  Admin Task Detail — click a task on the admin list to open here. Shows the
  task's own fields (editable, incl. the client and the fee-engine Service) and
  the full notes thread added along the way. The client name links back to the
  client screen.
*/
export default function AdminTaskDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const canPipeline = !!profile?.can_manage_task_pipeline;

  const [task, setTask] = useState(null);
  const [entity, setEntity] = useState(null);
  const [notes, setNotes] = useState([]);
  const [staffMap, setStaffMap] = useState({});
  const [allEntities, setAllEntities] = useState([]);
  const [newClientModal, setNewClientModal] = useState({ open: false, initialName: '', resolve: null });
  const [fees, setFees] = useState([]); // standard_fees price book
  const [serviceOptions, setServiceOptions] = useState([]); // the Billing module's own service options
  const [bill, setBill] = useState(null); // linked billing_items row
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');

  // Editable form state (mirrors the task; saved on the Save button).
  const [form, setForm] = useState({ title: '', entity_id: '', service_id: '', deadline: '', urgent: false, detail: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: t, error: e1 }, { data: n }, { data: st }, { data: ents }, { data: sf }, svc] = await Promise.all([
        supabase.from('admin_tasks').select('*, entity:entities(id, name)').eq('id', id).single(),
        supabase.from('admin_task_notes').select('*').eq('task_id', id).order('created_at', { ascending: true }),
        supabase.from('staff_profiles').select('id, name, email'),
        supabase.from('entities').select('id, name').order('name'),
        supabase.from('standard_fees').select('task_name, service_id, standard_net').order('task_name'),
        fetchAdhocServices(),
      ]);
      if (e1) throw e1;
      setTask(t);
      setEntity(t?.entity || null);
      setNotes(n || []);
      setStaffMap(Object.fromEntries((st || []).map((s) => [s.id, s.name || s.email])));
      setAllEntities(ents || []);
      setFees(sf || []);
      setServiceOptions(svc || []);
      setForm({
        title: t?.title || '', entity_id: t?.entity_id || '', service_id: t?.service_id || '',
        deadline: t?.deadline || '', urgent: !!t?.urgent, detail: t?.detail || '',
      });
      if (t?.billing_item_id) {
        const { data: b } = await supabase.from('billing_items')
          .select('id, service, net_amount, gross_amount, status, qbo_invoice_id, qbo_doc_number').eq('id', t.billing_item_id).maybeSingle();
        setBill(b || null);
      } else {
        setBill(null);
      }
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // The task's service has to be one the Billing module offers — that's where
  // its bill lands, and the service is what resolves to a QuickBooks product
  // on the push. Same picker, same list. ServicePicker keeps a value that
  // isn't in the list visible and flagged, so an older task can't be blanked
  // just by opening it.
  const isBillableService = (id) => !!id && serviceOptions.some((o) => o.id === id);
  const feeFor = (serviceId) => {
    const f = fees.find((x) => x.service_id === serviceId);
    return f ? Number(f.standard_net) : null;
  };

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Same as the admin list: the client picker's "+ Add" opens the shared
  // NewClientModal and resolves with the new entity so the picker selects it.
  const openNewClientModal = useCallback((name) => (
    new Promise((resolve) => setNewClientModal({ open: true, initialName: name, resolve }))
  ), []);

  const handleNewClientSave = useCallback(async (fields) => {
    const data = await insertEntity(fields); // throws → the modal keeps the error on screen
    setAllEntities((prev) => [...prev, { id: data.id, name: data.name }]
      .sort((a, b) => a.name.localeCompare(b.name)));
    setNewClientModal((m) => { if (m.resolve) m.resolve(data); return { open: false, initialName: '', resolve: null }; });
    return data;
  }, []);

  const handleNewClientClose = useCallback(() => {
    setNewClientModal((m) => { if (m.resolve) m.resolve(null); return { open: false, initialName: '', resolve: null }; });
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    const patch = {
      title: form.title.trim(),
      entity_id: form.entity_id || null,
      service_id: form.service_id || null,
      deadline: form.deadline || null,
      urgent: !!form.urgent,
      detail: form.detail.trim() || null,
    };
    const { error: e } = await supabase.from('admin_tasks').update(patch).eq('id', id);
    if (e) { setError(e.message); setSaving(false); return; }
    setSaving(false);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1600);
    load();
  };

  const addNote = async () => {
    const body = noteDraft.trim();
    if (!body) return;
    const { data, error: e } = await supabase.from('admin_task_notes')
      .insert({ task_id: id, author_id: profile?.id || null, kind: 'note', body }).select('*').single();
    if (e) { setError(e.message); return; }
    setNotes((prev) => [...prev, data]);
    setNoteDraft('');
  };

  const setStage = async (stage) => {
    const { error: e } = await supabase.from('admin_tasks').update({ stage }).eq('id', id);
    if (e) { setError(e.message); return; }
    load();
  };

  const addBill = async () => {
    if (!form.entity_id) { setError('Set a client on the task before billing it.'); return; }
    // 'Admin' used to be the fallback code here. It's no longer billable — it
    // mapped to a QBO item on a catch-all income account — so the service has
    // to be a real one, chosen now rather than discovered at push time.
    if (!form.service_id) { setError('Set the task\'s service before billing it — pick the service the work actually was.'); return; }
    // Anything the Billing module doesn't offer resolves to no QuickBooks
    // product, so it would only fail at push time — refuse it here instead.
    if (!isBillableService(form.service_id)) {
      setError(`"${form.service_id}" isn't a billing service — pick one from the list before billing this task.`);
      return;
    }
    const std = feeFor(form.service_id);
    const raw = window.prompt('Net amount to bill (excl. VAT) — enter 0 if the figure isn\'t settled yet:', std != null ? String(std) : '');
    if (raw === null) return;
    // 0 raises it as a £0.00 draft to be priced in the Billing module, which
    // won't let a £0.00 bill be approved or pushed.
    const net = String(raw).trim() === '' ? 0 : parseFloat(raw);
    if (!Number.isFinite(net) || net < 0) { setError('Enter a net amount of 0 or more.'); return; }
    const vat = Math.round(net * VAT_RATE * 100) / 100;
    const gross = Math.round((net + vat) * 100) / 100;
    const { data: b, error: be } = await supabase.from('billing_items').insert({
      entity_id: form.entity_id, service: form.service_id, description: form.title.trim(),
      net_amount: net, vat_amount: vat, gross_amount: gross, status: 'draft', created_by: profile?.id || null,
    }).select('id').single();
    if (be) { setError(be.message); return; }
    const { error: ue } = await supabase.from('admin_tasks')
      .update({ billable: true, billing_item_id: b.id, stage: 'bill_hold' }).eq('id', id);
    if (ue) { setError(ue.message); return; }
    load();
  };

  if (loading) return <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px 24px', fontFamily: font, color: '#94a3b8', fontSize: 13 }}>Loading task…</div>;
  if (!task) return <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px 24px', fontFamily: font, color: '#ef4444', fontSize: 13 }}>Task not found.</div>;

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px 24px 48px', fontFamily: font }}>
      <button onClick={() => navigate('/planner/tasks')} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 13, marginBottom: 16, padding: 0 }}>
        <ChevronLeft size={16} /> Back to Admin tasks
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' }}>Task detail</h1>
        {task.source && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: '#f1f5f9', color: '#64748b' }}>{task.source}</span>}
      </div>
      {entity && (
        <div style={{ marginBottom: 18 }}>
          <button onClick={() => navigate(`/clients/${entity.id}`)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: '#0e7fe0', fontSize: 13.5, fontWeight: 600, padding: 0 }}>
            {entity.name} <ExternalLink size={13} />
          </button>
        </div>
      )}

      {error && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>{error}</div>}

      {/* Editable task fields */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <div style={label}>Task</div>
          <input value={form.title} onChange={(e) => setField('title', e.target.value)} style={inputStyle} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 12 }}>
          <div>
            <div style={label}>Client</div>
            <ClientTypeAhead entityList={allEntities} value={form.entity_id} onChange={(v) => setField('entity_id', v)} onAddNew={openNewClientModal} size="small" />
          </div>
          <div>
            <div style={label}>Service (as billed)</div>
            <ServicePicker
              value={form.service_id}
              options={serviceOptions}
              onChange={(v) => setField('service_id', v)}
              placeholder="— none —"
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 12, alignItems: 'end' }}>
          <div>
            <div style={label}>Deadline</div>
            <input type="date" value={form.deadline || ''} onChange={(e) => setField('deadline', e.target.value)} style={inputStyle} />
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#475569', cursor: 'pointer', paddingBottom: 8 }}>
            <input type="checkbox" checked={form.urgent} onChange={(e) => setField('urgent', e.target.checked)} style={{ width: 14, height: 14, accentColor: '#dc2626' }} />
            <Flame size={13} color={form.urgent ? '#dc2626' : '#64748b'} /> Urgent
          </label>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={label}>Notes / description</div>
          <textarea value={form.detail} onChange={(e) => setField('detail', e.target.value)} rows={2}
            style={{ ...inputStyle, resize: 'vertical' }} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={save} disabled={saving || !form.title.trim()}
            style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: form.title.trim() ? '#0f172a' : '#e5e7eb', color: form.title.trim() ? '#fff' : '#94a3b8', border: 'none', borderRadius: 8, cursor: form.title.trim() ? 'pointer' : 'not-allowed', fontFamily: font }}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {savedFlash && <span style={{ fontSize: 12.5, color: '#059669', fontWeight: 600 }}>✓ Saved</span>}

          {/* Billing */}
          {bill ? (
            <button onClick={() => navigate(`/billing?highlight=${task.billing_item_id}`)}
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, color: '#0e7fe0', background: '#fff', border: '1px solid #bae6fd', borderRadius: 8, cursor: 'pointer', fontFamily: font }}>
              <Receipt size={13} /> Review bill {bill.qbo_doc_number ? `#${bill.qbo_doc_number}` : ''} · £{bill.net_amount} ({bill.status})
            </button>
          ) : (
            <button onClick={addBill}
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, color: '#0e7fe0', background: '#fff', border: '1px solid #bae6fd', borderRadius: 8, cursor: 'pointer', fontFamily: font }}>
              <Receipt size={13} /> Add a bill{form.service_id && feeFor(form.service_id) != null ? ` (£${feeFor(form.service_id)})` : ''}
            </button>
          )}
        </div>

        {canPipeline && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 12, borderTop: '1px solid #f1f5f9' }}>
            <span style={label}>Pipeline step</span>
            <select value={task.stage || 'todo'} onChange={(e) => setStage(e.target.value)}
              style={{ fontSize: 12.5, fontFamily: font, padding: '5px 8px', borderRadius: 6, border: '1px solid #e2e8f0', color: '#475569', outline: 'none' }}>
              {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* Notes thread */}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 10 }}>Notes &amp; responses ({notes.length})</div>
        {notes.length === 0 && <div style={{ fontSize: 12.5, color: '#94a3b8' }}>No notes yet.</div>}
        {notes.map((n) => (
          <div key={n.id} style={{ fontSize: 12.5, color: '#334155', padding: '6px 0', borderBottom: '1px solid #f8fafc', display: 'flex', gap: 8 }}>
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, flexShrink: 0, height: 16, marginTop: 1, background: n.kind === 'escalation' ? '#fef3c7' : '#eef2ff', color: n.kind === 'escalation' ? '#b45309' : '#4338ca' }}>
              {n.kind === 'escalation' ? 'escalation' : 'note'}
            </span>
            <div>
              <span>{n.body}</span>
              <span style={{ color: '#94a3b8', marginLeft: 6, fontSize: 11 }}>— {staffMap[n.author_id] || 'staff'} · {fmtNoteTime(n.created_at)}</span>
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }}
            placeholder="Add a note or response…" style={inputStyle} />
          <button onClick={addNote} disabled={!noteDraft.trim()}
            style={{ padding: '8px 12px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
            <Send size={13} />
          </button>
        </div>
      </div>

      <NewClientModal
        open={newClientModal.open}
        initialName={newClientModal.initialName}
        onClose={handleNewClientClose}
        onSave={handleNewClientSave}
      />
    </div>
  );
}
