import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarCheck, ClipboardList, FileText, History, ListTodo, Mail, MessageSquare, MessageSquarePlus, Paperclip, Plus, Receipt, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../AppShell';
import { BTN } from '../../lib/buttonStyles';
import { tones } from '../../lib/tokens';
import ClientNamePicker from '../../components/ClientNamePicker';
import { SERVICES } from '../../modules/work-planner/lib/constants';
import { fetchAdhocServices } from '../../modules/billing/billingServices';
import ServicePicker from '../../modules/billing/ServicePicker';
import NewClientModal from '../../components/NewClientModal';
import { insertEntity } from '../../modules/work-planner/lib/supabaseQueries';
// The Billing page's own line editor + past-invoice picker (one shared copy).
import { blankLine, buildLinesPayload, useBillLines, BillLinesEditor, PastInvoicePicker } from '../../modules/billing/billLines';
import { gmail } from '../../modules/communications/api';
import { emailReference } from './createBus';

// "+ Create" — one place to make the things work turns into: a quick task,
// an admin task, a meeting agenda item, a bill, or a quote.
//
// Opened from the top bar on any page, or from an open email (which fills in
// the client from the sender, the subject as the title, and a link back to
// the email). It stays open until you close it — clicking beside it doesn't —
// and after each create it offers to open the result or create another.
//
// Writes: athena-create (quick task / admin task / bill, as the caller so the
// usual permissions apply), client-agenda (agenda item). A quote opens the
// existing quote form with the client filled in — one set of quote maths.

const font = "'Outfit', sans-serif";
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const gbp = (n) => `£${(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TYPES = [
  { id: 'quick', label: 'Quick task', Icon: ListTodo, hint: 'A to-do on someone’s Work Planner.' },
  { id: 'admin', label: 'Admin task', Icon: ClipboardList, hint: 'On the Admin Task List — can carry a bill.' },
  { id: 'agenda', label: 'Agenda item', Icon: MessageSquarePlus, hint: 'A point for the client’s next review meeting.' },
  { id: 'bill', label: 'Bill', Icon: Receipt, hint: 'A one-off bill, saved as a draft for approval.' },
  { id: 'quote', label: 'Quote', Icon: FileText, hint: 'Opens the quote form for this client.' },
];

async function callCreate(action, body) {
  const { data, error } = await supabase.functions.invoke('athena-create', { body: { action, ...body } });
  if (error) {
    let msg = error.message;
    try { const b = await error.context?.json(); if (b?.error) msg = b.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (data?.success === false) throw new Error(data.error || 'Failed');
  return data;
}

export default function CreateModal() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState(null);
  const [type, setType] = useState('quick');
  const [done, setDone] = useState(null); // { text, to }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // shared
  const [clientText, setClientText] = useState('');
  const [client, setClient] = useState(null); // { id, name }
  const [suggested, setSuggested] = useState([]);
  const [linkEmail, setLinkEmail] = useState(true);
  // lookups
  const [staff, setStaff] = useState([]);
  const [adhoc, setAdhoc] = useState([]);
  // per type
  const [f, setF] = useState({});
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  // Bill: the Billing page's editor, standard descriptions from the products.
  const serviceDefaults = useMemo(() => Object.fromEntries(adhoc.map((s) => [s.id, s.defaultDescription || ''])), [adhoc]);
  const lineForm = useBillLines(serviceDefaults);
  const [newClientOpen, setNewClientOpen] = useState(false);
  const [invPickerOpen, setInvPickerOpen] = useState(false);
  const [files, setFiles] = useState([]);              // admin task attachments
  const [emailAtt, setEmailAtt] = useState(new Set()); // the email's attachments to carry over

  const canQuick = !!profile?.work_planner || !!profile?.is_portal_admin;
  const canBill = !!(profile?.can_view_client_fees || profile?.can_view_billing || profile?.is_portal_admin);

  const reset = useCallback((c) => {
    const subject = c?.kind === 'email' ? (c.subject || '').replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '') : '';
    setF({
      title: subject, notes: '', service: 'Admin', assignee: profile?.id || '', due: plusDays(5), planned: '', duration: 15,
      deadline: '', urgent: false, billable: false, serviceId: '', net: '',
      point: subject, bucket: 'agenda', billNote: '',
    });
    lineForm.setFormLines([blankLine()]);
    setFiles([]); setEmailAtt(new Set());
    setClient(null); setClientText(''); setSuggested([]); setDone(null); setError(''); setLinkEmail(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    const onOpen = (e) => {
      const c = e.detail || null;
      setCtx(c);
      reset(c);
      setOpen(true);
      // From an email: which client is this? (sender + other parties)
      if (c?.emails?.length) {
        callCreate('match_clients', { emails: c.emails }).then((r) => {
          setSuggested(r.clients || []);
          if (r.clients?.length === 1) { setClient(r.clients[0]); setClientText(r.clients[0].name); }
        }).catch(() => {});
      }
    };
    window.addEventListener('athena:create', onOpen);
    return () => window.removeEventListener('athena:create', onOpen);
  }, [reset]);

  useEffect(() => {
    if (!open || staff.length) return;
    supabase.from('staff_profiles').select('id, name, work_planner, is_active').eq('is_active', true).order('name')
      .then(({ data }) => setStaff(data || []));
    fetchAdhocServices().then(setAdhoc).catch(() => {});
  }, [open, staff.length]);

  const ref = linkEmail ? emailReference(ctx) : '';
  const withRef = (text) => [text?.trim(), ref].filter(Boolean).join('\n\n');

  const billTotals = lineForm.totals;

  // Admin task attachments, stored exactly as the Admin Task List stores them
  // (client-documents/admin-tasks/<task>/…, a row in admin_task_documents).
  const uploadOne = async (taskId, file) => {
    const safe = (file.name || 'file').replace(/[^\w.\-]+/g, '_');
    const path = `admin-tasks/${taskId}/${crypto.randomUUID()}-${safe}`;
    const { error: upErr } = await supabase.storage.from('client-documents').upload(path, file, { contentType: file.type || undefined });
    if (upErr) throw new Error(`Upload failed for ${file.name}: ${upErr.message}`);
    const { error: rowErr } = await supabase.from('admin_task_documents').insert({
      task_id: taskId, storage_path: path, original_name: file.name,
      mime_type: file.type || null, size_bytes: file.size || null, uploaded_by: profile?.id || null,
    });
    if (rowErr) throw new Error(rowErr.message);
  };
  // The email's own attachments, fetched from Gmail and stored the same way.
  const emailFile = async (a) => {
    const res = await gmail.getAttachment(ctx.mailbox, a.messageId, a.attachmentId);
    const b64 = String(res.data || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], a.filename || 'attachment', { type: a.mimeType || 'application/octet-stream' });
  };
  const close = () => { setOpen(false); setCtx(null); };

  const submit = async ({ asDraft = false } = {}) => {
    setBusy(true); setError('');
    try {
      if (type === 'quick') {
        await callCreate('quick_task', {
          title: f.title, entity_id: client?.id, service: f.service, assignee_id: f.assignee,
          due_date: f.due, planned_date: f.planned || null, duration: f.duration, notes: withRef(f.notes),
        });
        const who = staff.find((s) => s.id === f.assignee)?.name || 'them';
        setDone({ text: `Quick task created for ${who}${f.due ? `, due ${new Date(f.due).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}.`, to: '/planner/quick' });
      } else if (type === 'admin') {
        const r = await callCreate('admin_task', {
          title: f.title, entity_id: client?.id, deadline: f.deadline || null, detail: withRef(f.notes),
          urgent: f.urgent, draft: asDraft, billable: f.billable, service_id: f.serviceId || null, net: f.net,
        });
        // Files after the task exists (they hang off its id).
        const attach = [...files];
        const failed = [];
        for (const a of (ctx?.attachments || []).filter((x) => emailAtt.has(x.attachmentId))) {
          try { attach.push(await emailFile(a)); } catch { failed.push(a.filename); }
        }
        for (const file of attach) {
          try { await uploadOne(r.id, file); } catch { failed.push(file.name); }
        }
        setDone({
          text: `Admin task created${asDraft ? ' as a draft' : f.billable ? ' in Bill & Hold' : ''}.`
            + `${r.billError ? ` The bill wasn't: ${r.billError}` : r.billId ? ' Draft bill raised.' : ''}`
            + `${attach.length - failed.length > 0 ? ` ${attach.length - failed.length} file${attach.length - failed.length === 1 ? '' : 's'} attached.` : ''}`
            + `${failed.length ? ` Couldn't attach: ${failed.join(', ')}.` : ''}`,
          to: `/planner/tasks/${r.id}`,
        });
      } else if (type === 'agenda') {
        if (!client) throw new Error('Choose the client.');
        const { data, error: err } = await supabase.functions.invoke('client-agenda', {
          body: { action: 'add_item', entity_id: client.id, bucket: f.bucket, body: withRef(f.point) },
        });
        if (err || data?.success === false) throw new Error(data?.error || err?.message || 'Failed');
        setDone({ text: `Added to ${client.name}’s ${f.bucket === 'info' ? 'info for the meeting' : 'meeting agenda'}.`, to: `/clients/${client.id}` });
      } else if (type === 'bill') {
        if (!client) throw new Error('Choose the client to bill.');
        const { lines } = buildLinesPayload(lineForm.formLines);
        if (!lines.length) throw new Error('Add at least one line with a service and an amount.');
        await callCreate('bill', { entity_id: client.id, lines, note: withRef(f.billNote) });
        setDone({ text: `Draft bill for ${client.name} (${gbp(billTotals.gross)} inc VAT) — it needs approving before it goes to QuickBooks.`, to: '/billing' });
      } else if (type === 'quote') {
        close();
        navigate(client ? `/manage/quotes/new?entity=${client.id}` : '/manage/quotes/new');
        return;
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const T = TYPES.find((x) => x.id === type);
  const blocked = (type === 'quick' && !canQuick) ? 'Quick tasks need Work Planner access.'
    : (type === 'bill' && !canBill) ? 'Bills need billing access.'
      : (type === 'admin' && f.billable && !canBill) ? 'You can make the task, but billing it needs billing access.' : '';
  const needsClient = type === 'agenda' || type === 'bill' || (type === 'admin' && f.billable);
  const ready = !busy && !(type === 'quick' && !canQuick) && !(type === 'bill' && !canBill)
    && (type === 'quote' || (needsClient ? !!client : true))
    && (type === 'quick' || type === 'admin' ? !!f.title?.trim() : true)
    && (type === 'quick' ? !!f.assignee : true)
    && (type === 'agenda' ? !!f.point?.trim() : true)
    && (type === 'bill' ? lineForm.canSubmit : true);

  return (
    // No backdrop click-to-close and no Esc: it stays until you close it.
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 120, fontFamily: font }}>
      <div style={{ width: 1100, maxWidth: '96vw', height: 'min(720px, calc(100vh - 40px))', background: '#fff', borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(15,23,42,.25)' }}>
        {/* The shared client picker's input, matched to this form's fields. */}
        <style>{'.create-client-picker input{border:1px solid #cbd5e1!important;border-radius:7px!important;padding:7px 10px!important;font-size:14px!important}'}</style>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid #e2e8f0' }}>
          <Plus size={18} color={tones.info.solid} />
          <span style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>Create</span>
          <button onClick={close} title="Close" style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}><X size={18} /></button>
        </div>

        {ctx?.kind === 'email' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: 13, color: '#475569' }}>
            <Mail size={14} color="#64748b" />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              From email: <b style={{ color: '#0f172a' }}>{ctx.subject || '(no subject)'}</b> — {ctx.fromName || ctx.fromEmail}
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', cursor: 'pointer' }}>
              <input type="checkbox" checked={linkEmail} onChange={(e) => setLinkEmail(e.target.checked)} /> Link the email
            </label>
          </div>
        )}

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Types */}
          <div style={{ width: 190, flexShrink: 0, borderRight: '1px solid #e2e8f0', padding: 10, display: 'flex', flexDirection: 'column', gap: 4, background: '#fcfdfe' }}>
            {TYPES.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => { setType(id); setDone(null); setError(''); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', fontSize: 14, fontFamily: font, textAlign: 'left',
                  border: 'none', borderRadius: 8, cursor: 'pointer',
                  background: type === id ? tones.info.bg : 'transparent', color: type === id ? tones.info.fg : '#334155', fontWeight: type === id ? 700 : 500,
                }}
              >
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>

          {/* Form */}
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 13, color: '#64748b' }}>{T.hint}</div>

            {done ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, color: '#166534', fontSize: 14 }}>
                <span><CalendarCheck size={15} style={{ verticalAlign: -2 }} /> {done.text}</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => { close(); navigate(done.to); }} style={{ ...BTN.secondary.md, cursor: 'pointer' }}>Open it</button>
                  <button onClick={() => { const c = ctx; reset(c); setCtx(c); }} style={{ ...BTN.secondary.md, cursor: 'pointer' }}>Create another</button>
                  <button onClick={close} style={{ ...BTN.primary.md, cursor: 'pointer', marginLeft: 'auto' }}>Done</button>
                </div>
              </div>
            ) : (
              <>
                {blocked && <div style={{ padding: '8px 12px', background: tones.warning.bg, color: tones.warning.fg, borderRadius: 8, fontSize: 13 }}>{blocked}</div>}

                {(type === 'quick' || type === 'admin') && (
                  <Field label="Title" required>
                    <input value={f.title} onChange={(e) => set('title', e.target.value)} autoFocus style={input} />
                  </Field>
                )}

                <Field label="Client" required={needsClient}>
                  <ClientNamePicker
                    className="create-client-picker"
                    value={clientText}
                    onChange={setClientText}
                    onPick={(row) => { setClient({ id: row.id, name: row.name }); setClientText(row.name); }}
                    linked={client}
                    onUnlink={() => setClient(null)}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button type="button" onClick={() => setNewClientOpen(true)} style={{ ...BTN.secondary.sm, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Plus size={13} /> New client
                    </button>
                    {type === 'bill' && (
                      <button type="button" onClick={() => setInvPickerOpen(true)} disabled={!client}
                        title="Copy a past QBO invoice into this bill"
                        style={{ ...BTN.secondary.sm, cursor: client ? 'pointer' : 'not-allowed', opacity: client ? 1 : 0.45, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <History size={13} /> Copy from past invoice
                      </button>
                    )}
                  </div>
                  {suggested.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, fontSize: 12.5, color: '#64748b', alignItems: 'center' }}>
                      From the email:
                      {suggested.map((c) => (
                        <button key={c.id} onClick={() => { setClient(c); setClientText(c.name); }}
                          style={{ padding: '2px 9px', fontSize: 12.5, fontFamily: font, borderRadius: 999, cursor: 'pointer', border: `1px solid ${client?.id === c.id ? tones.info.solid : '#cbd5e1'}`, background: client?.id === c.id ? tones.info.bg : '#fff', color: client?.id === c.id ? tones.info.fg : '#334155' }}>
                          {c.name}
                        </button>
                      ))}
                    </div>
                  )}
                </Field>

                {type === 'quick' && (
                  <>
                    <Row>
                      <Field label="For" required>
                        <select value={f.assignee} onChange={(e) => set('assignee', e.target.value)} style={input}>
                          <option value="">Choose…</option>
                          {staff.filter((s) => s.work_planner !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </Field>
                      <Field label="Service">
                        <select value={f.service} onChange={(e) => set('service', e.target.value)} style={input}>
                          {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </Field>
                    </Row>
                    <Row>
                      <Field label="Due"><input type="date" value={f.due} onChange={(e) => set('due', e.target.value)} style={input} /></Field>
                      <Field label="Planned for"><input type="date" value={f.planned} onChange={(e) => set('planned', e.target.value)} style={input} /></Field>
                      <Field label="Minutes"><input type="number" min={5} step={5} value={f.duration} onChange={(e) => set('duration', e.target.value)} style={input} /></Field>
                    </Row>
                    <Field label="Notes"><textarea rows={4} value={f.notes} onChange={(e) => set('notes', e.target.value)} style={{ ...input, resize: 'vertical' }} /></Field>
                  </>
                )}

                {type === 'admin' && (
                  <>
                    <Row>
                      <Field label="Target date"><input type="date" value={f.deadline} onChange={(e) => set('deadline', e.target.value)} style={input} /></Field>
                      <Field label=" ">
                        <label style={{ ...check, height: 36, fontSize: 13.5, color: '#334155' }}>
                          <input type="checkbox" checked={f.urgent} onChange={(e) => set('urgent', e.target.checked)} style={{ accentColor: '#dc2626' }} /> Urgent
                        </label>
                      </Field>
                    </Row>
                    <Field label="Notes"><textarea rows={3} value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Notes (optional)" style={{ ...input, resize: 'vertical' }} /></Field>
                    <Row>
                      {/* A div, not a label: ServicePicker is a custom control. */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: '#475569' }}>Service{f.billable && <span style={{ color: '#b91c1c' }}> *</span>}</span>
                        <ServicePicker value={f.serviceId} options={adhoc} onChange={(v) => set('serviceId', v)} placeholder="— none —" style={input} />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label style={{ ...check, fontSize: 13.5, color: '#334155', height: 22 }}>
                          <input type="checkbox" checked={f.billable} onChange={(e) => set('billable', e.target.checked)} /> <Receipt size={13} color="#64748b" /> Billable — raise a bill
                        </label>
                        {f.billable && (
                          <input value={f.net} onChange={(e) => set('net', e.target.value)} inputMode="decimal" placeholder="Net amount £ (blank = standard fee)" style={input} />
                        )}
                      </div>
                    </Row>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: '#475569' }}>Attachments</span>
                      <label style={{ ...BTN.secondary.sm, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start' }}>
                        <Paperclip size={13} /> {files.length ? `${files.length} file${files.length === 1 ? '' : 's'} chosen` : 'Attach files'}
                        <input type="file" multiple style={{ display: 'none' }} onChange={(e) => setFiles(Array.from(e.target.files || []))} />
                      </label>
                      {files.length > 0 && <span style={{ fontSize: 12.5, color: '#94a3b8' }}>{files.map((x) => x.name).join(', ')}</span>}
                      {ctx?.attachments?.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13, color: '#334155' }}>
                          <span style={{ fontSize: 12, color: '#64748b' }}>From the email:</span>
                          {ctx.attachments.map((a) => (
                            <label key={a.attachmentId} style={check}>
                              <input
                                type="checkbox"
                                checked={emailAtt.has(a.attachmentId)}
                                onChange={(e) => setEmailAtt((prev) => { const n = new Set(prev); if (e.target.checked) n.add(a.attachmentId); else n.delete(a.attachmentId); return n; })}
                              />
                              <Paperclip size={12} color="#94a3b8" /> {a.filename} <span style={{ color: '#94a3b8' }}>({Math.max(1, Math.round((a.size || 0) / 1024))} KB)</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {type === 'agenda' && (
                  <>
                    <Field label="Point to raise" required>
                      <textarea rows={4} value={f.point} onChange={(e) => set('point', e.target.value)} style={{ ...input, resize: 'vertical' }} />
                    </Field>
                    <Field label="Goes under">
                      <select value={f.bucket} onChange={(e) => set('bucket', e.target.value)} style={input}>
                        <option value="agenda">Agenda — to discuss</option>
                        <option value="info">For info</option>
                      </select>
                    </Field>
                  </>
                )}

                {type === 'bill' && (
                  <>
                    <div>
                      <BillLinesEditor form={lineForm} services={adhoc} serviceDefaults={serviceDefaults} />
                    </div>
                    <div style={{ alignSelf: 'flex-end', fontSize: 14, color: '#64748b' }}>
                      Total: <b style={{ color: '#0f172a' }}>{gbp(billTotals.net)}</b> net · {gbp(billTotals.vat)} VAT · <b style={{ color: '#0e7fe0' }}>{gbp(billTotals.gross)}</b> gross
                    </div>
                    <Field label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><MessageSquare size={12} /> Comment for whoever reviews this</span>}>
                      <textarea rows={2} value={f.billNote} onChange={(e) => set('billNote', e.target.value)}
                        placeholder="e.g. rebuilt 14 months of bookkeeping after the old bookkeeper left — agreed with the client on the call"
                        style={{ ...input, resize: 'vertical' }} />
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>
                        Internal only — stays in Athena. It isn&apos;t sent to QuickBooks and the client never sees it. Use the line Description for anything that should appear on the invoice.
                      </span>
                    </Field>
                  </>
                )}

                {type === 'quote' && (
                  <div style={{ fontSize: 13.5, color: '#475569', lineHeight: 1.5 }}>
                    The quote form opens with {client ? <b>{client.name}</b> : 'a new client'} filled in — pick the services and pricing there.
                  </div>
                )}

                {error && <div style={{ padding: '8px 12px', background: '#fee2e2', color: '#b91c1c', borderRadius: 8, fontSize: 13 }}>{error}</div>}
              </>
            )}
          </div>
        </div>

        <NewClientModal
          open={newClientOpen}
          initialName={client ? '' : clientText}
          onClose={() => setNewClientOpen(false)}
          onSave={async (fields) => {
            const data = await insertEntity(fields); // throws → the modal shows it and stays open
            setClient({ id: data.id, name: data.name }); setClientText(data.name); setNewClientOpen(false);
            return data;
          }}
        />
        {invPickerOpen && client && (
          <PastInvoicePicker
            entityId={client.id} entityName={client.name} fmt={gbp}
            onCopy={(lines) => { lineForm.setFormLines(lines); setInvPickerOpen(false); }}
            onClose={() => setInvPickerOpen(false)}
          />
        )}

        {!done && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderTop: '1px solid #e2e8f0' }}>
            {ref && type !== 'quote' && <span style={{ fontSize: 12, color: '#94a3b8' }}>A link back to the email is added to the notes.</span>}
            <button onClick={close} style={{ ...BTN.secondary.md, cursor: 'pointer', marginLeft: 'auto' }}>Cancel</button>
            {type === 'admin' && (
              <button onClick={() => submit({ asDraft: true })} disabled={!ready} title="Held off the live list until you publish it"
                style={{ ...BTN.secondary.md, cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.5 }}>
                Save as draft
              </button>
            )}
            <button onClick={() => submit()} disabled={!ready} style={{ ...BTN.primary.md, cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.5 }}>
              {busy ? 'Creating…' : type === 'quote' ? 'Open quote form' : `Create ${T.label.toLowerCase()}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const input = { width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 7, background: '#fff', color: '#0f172a' };
const check = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' };

function Field({ label, required, hint, children }) {
  return (
    // No flex-grow here: in the form's column it stretched each field to fill
    // the height (the gap under Client). Row gives side-by-side fields width.
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: '#475569' }}>
        {label}{required && <span style={{ color: '#b91c1c' }}> *</span>}
        {hint && <span style={{ fontWeight: 400, color: '#94a3b8' }}> · {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Row({ children }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      {React.Children.map(children, (c) => <div style={{ flex: 1, minWidth: 0 }}>{c}</div>)}
    </div>
  );
}
