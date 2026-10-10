import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Bold, Italic, Underline, List, Link2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../AppShell';
import { BTN } from '../../lib/buttonStyles';
import { listMailboxes, loadSignatureSets, pickSignature, gmail } from '../../modules/communications/api';
import {
  FIELDS, fieldMeta, placeholdersIn, textToHtml, htmlToText, renderHtml, renderText, toChips, fromChips, chipHtml,
} from './fields';

const font = "'Outfit', sans-serif";

// The email template library (sql/373). Every client email template in one
// place, in groups. Pick a client and a template: Athena fills what it knows,
// asks for the rest, adds your signature, and sends through the Communications
// outbox (20-second undo, Sent copy, logged on the client). Edit switches the
// same editor to the template itself.
//
// Closes only on Close: no backdrop click, no Escape, so a half-written email
// is never lost.

const GROUPS = [
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'tax_payments', label: 'Tax Payments' },
  { key: 'records_year_end', label: 'Records & Year End' },
  { key: 'triage', label: 'Triage' },
  { key: 'billing_update', label: 'Billing Update', note: 'Fee reviews, new fees and quotes are written by their own screens in the Fee Engine, which add the fee table and accept link.' },
  { key: 'financial_overview', label: 'Financial Overview' },
  { key: 'companies_house', label: 'Companies House' },
  { key: 'payroll', label: 'Payroll' },
  { key: 'general', label: 'General' },
  { key: 'debt_chasing', label: 'Debt Chasing', note: 'Sent from Fee Engine → Debt chasing, which adds the overdue invoices. Edit them here.', noSend: true },
];
const CH_LABEL_FALLBACK = { offer: 'ID verification: your options', reminder: 'ID verification: reminder', id_poa: 'ID verification: ID and proof of address', self_verify: 'ID verification: verify yourself', code: 'ID verification: forward your personal code' };
const CH_SORT = { offer: 10, reminder: 20, id_poa: 30, self_verify: 40, code: 50 };

async function loadTemplates() {
  const [a, b] = await Promise.all([
    supabase.from('comm_templates').select('id, comm_type, kind, library_group, label, sort, description, subject, body_html, body_text, updated_at')
      .not('library_group', 'is', null).order('sort'),
    supabase.from('ch_code_email_templates').select('key, label, subject, body_html, updated_at'),
  ]);
  if (a.error) throw a.error;
  const rows = (a.data || []).map((r) => ({
    ...r, source: 'comm', id: r.id, group: r.library_group,
    plainText: !String(r.body_html || '').trim(),
    html: String(r.body_html || '').trim() ? r.body_html : textToHtml(r.body_text),
  }));
  for (const r of b.data || []) {
    rows.push({
      source: 'ch', id: `ch:${r.key}`, chKey: r.key, group: 'companies_house', sort: CH_SORT[r.key] ?? 70,
      label: CH_LABEL_FALLBACK[r.key] || r.label, subject: r.subject, html: r.body_html,
      description: 'Also sent from CH Codes. {{person}} is the director; {{entity}} the company.',
      updated_at: r.updated_at,
    });
  }
  return rows.sort((x, y) => (x.sort ?? 100) - (y.sort ?? 100));
}

async function loadClient(entityId) {
  const [e, p] = await Promise.all([
    supabase.from('entities').select('id, name, utr, vat_number, company_number, paye_ref, accounts_office_ref, billing_email, prospect_email').eq('id', entityId).single(),
    supabase.from('entity_people').select('is_primary_contact, role, source, people(name, first_name, preferred_name, email)').eq('entity_id', entityId).is('ended_on', null),
  ]);
  if (e.error) throw e.error;
  const people = (p.data || []).filter((x) => x.people)
    .sort((a, b) => (b.is_primary_contact - a.is_primary_contact) || ((a.source === 'brightmanager' ? -1 : 0) - (b.source === 'brightmanager' ? -1 : 0)));
  const contacts = people.map((x) => ({
    fullName: x.people.name || '',
    firstName: (x.people.preferred_name || '').trim() || (x.people.first_name || '').trim() || String(x.people.name || '').split(/\s+/)[0],
    email: (x.people.email || '').trim(),
    role: x.role, primary: x.is_primary_contact,
  }));
  return { entity: e.data, contacts };
}

export default function TemplateLibraryModal() {
  const [open, setOpen] = useState(null); // ctx while open
  useEffect(() => {
    const h = (ev) => setOpen(ev.detail || {});
    window.addEventListener('athena:templates', h);
    return () => window.removeEventListener('athena:templates', h);
  }, []);
  if (!open) return null;
  return <Library ctx={open} onClose={() => setOpen(null)} />;
}

function Library({ ctx, onClose }) {
  const { profile } = useAuth();
  const [templates, setTemplates] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [openGroups, setOpenGroups] = useState(() => new Set(ctx.group ? [ctx.group] : ['onboarding']));
  const [selId, setSelId] = useState(null);
  const [mode, setMode] = useState('send'); // send | edit

  // Client
  const [entityId, setEntityId] = useState(ctx.entityId || null);
  const [client, setClient] = useState(null);
  const [contactIdx, setContactIdx] = useState(0);

  // Sending
  const [mailboxes, setMailboxes] = useState([]);
  const [mailbox, setMailbox] = useState('');
  const [sigSets, setSigSets] = useState({ templates: [], uses: [] });
  const [sigId, setSigId] = useState('auto');
  const [to, setTo] = useState(ctx.to || '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [subjectEdited, setSubjectEdited] = useState(false);
  const [values, setValues] = useState({});
  const [bodyEdited, setBodyEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState(null);
  const [queued, setQueued] = useState(null); // { id, mailbox, secs }
  const [sent, setSent] = useState('');
  const editorRef = useRef(null);

  // Editing
  const [editSubject, setEditSubject] = useState('');
  const [editDirty, setEditDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = async (keepSel) => {
    try {
      const t = await loadTemplates();
      setTemplates(t);
      if (keepSel) setSelId(keepSel);
    } catch (e) { setErr(e.message); setTemplates([]); }
  };

  useEffect(() => {
    reload();
    listMailboxes(profile).then((m) => {
      const live = (m || []).filter((x) => x.status === 'active');
      setMailboxes(live);
      const def = live.find((x) => /^info@/i.test(x.account_email)) || live.find((x) => x.is_practice_default) || live[0];
      setMailbox(def?.account_email || '');
    }).catch(() => {});
    if (profile?.id) loadSignatureSets(profile.id).then(setSigSets).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!entityId) { setClient(null); return; }
    loadClient(entityId).then((c) => {
      setClient(c);
      setContactIdx(0);
      if (!ctx.to || entityId !== ctx.entityId) {
        setTo(c.entity.billing_email || c.contacts.find((x) => x.email)?.email || c.entity.prospect_email || '');
      }
    }).catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  const sel = useMemo(() => (templates || []).find((t) => t.id === selId) || null, [templates, selId]);
  const group = GROUPS.find((g) => g.key === sel?.group);
  const contact = client?.contacts?.[contactIdx] || null;

  // Values Athena knows, plus defaults; what the sender typed wins.
  const fieldKeys = useMemo(() => (sel ? placeholdersIn(sel.subject, sel.html) : []), [sel]);
  const autoValues = useMemo(() => {
    const c = { entity: client?.entity, contact, profile, mailbox };
    const out = {};
    for (const k of fieldKeys) {
      const m = FIELDS[k];
      if (m?.auto) out[k] = m.auto(c);
      else if (m?.def) out[k] = m.def(c);
    }
    return out;
  }, [fieldKeys, client, contact, profile, mailbox]);
  const merged = useMemo(() => ({ ...autoValues, ...values }), [autoValues, values]);
  const missing = fieldKeys.filter((k) => !fieldMeta(k).optional && !String(merged[k] ?? '').trim());

  const signature = useMemo(() => {
    if (sigId === 'none') return null;
    if (sigId === 'auto') return pickSignature(sigSets, mailbox, 'new');
    return sigSets.templates.find((t) => t.id === sigId) || null;
  }, [sigId, sigSets, mailbox]);

  // Render into the editor until the sender edits the body directly.
  const rendered = useMemo(() => (sel ? renderHtml(sel.html, merged) : ''), [sel, merged]);
  useEffect(() => {
    if (mode !== 'send' || !editorRef.current || bodyEdited) return;
    editorRef.current.innerHTML = rendered;
  }, [rendered, mode, bodyEdited]);
  useEffect(() => { if (sel && mode === 'send' && !subjectEdited) setSubject(renderText(sel.subject, merged)); }, [sel, merged, mode, subjectEdited]);

  const choose = (t) => {
    if ((bodyEdited || editDirty) && !window.confirm('Switch template? Your changes to this one will be lost.')) return;
    setSelId(t.id); setValues({}); setBodyEdited(false); setSubjectEdited(false); setEditDirty(false); setWarnings(null); setSent('');
    if (mode === 'edit') startEdit(t);
  };

  // ── Edit mode ──
  const startEdit = (t = sel) => {
    if (!t) return;
    setMode('edit'); setEditSubject(t.subject); setEditDirty(false);
    setTimeout(() => { if (editorRef.current) editorRef.current.innerHTML = toChips(t.html); }, 0);
  };
  const stopEdit = () => {
    if (editDirty && !window.confirm('Leave without saving your changes to the template?')) return;
    setMode('send'); setEditDirty(false); setBodyEdited(false);
    setTimeout(() => { if (editorRef.current) editorRef.current.innerHTML = rendered; }, 0);
  };
  const saveTemplate = async () => {
    const html = fromChips(editorRef.current?.innerHTML || '').replace(/<span data-missing[^>]*>.*?<\/span>/g, '');
    setSaving(true); setErr('');
    try {
      const stamp = { updated_by: profile?.id, updated_at: new Date().toISOString() };
      if (sel.source === 'ch') {
        const { error } = await supabase.from('ch_code_email_templates').update({ subject: editSubject, body_html: html, ...stamp }).eq('key', sel.chKey);
        if (error) throw error;
      } else {
        // Workflows / Onboarding templates are sent as plain text: save them as text.
        const patch = sel.plainText
          ? { subject: editSubject, body_text: htmlToText(html) }
          : { subject: editSubject, body_html: html, body_text: htmlToText(html) };
        const { error } = await supabase.from('comm_templates').update({ ...patch, ...stamp }).eq('id', sel.id);
        if (error) throw error;
      }
      setEditDirty(false); setSubjectEdited(false);
      await reload(sel.id);
      setMode('send'); setBodyEdited(false);
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  };
  const newTemplate = async (groupKey) => {
    const label = window.prompt('Name the new template');
    if (!label?.trim()) return;
    const kind = `lib_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}_${Date.now().toString(36)}`;
    const { data, error } = await supabase.from('comm_templates').insert({
      comm_type: 'library', kind, library_group: groupKey, label: label.trim(), sort: 500,
      subject: '{{client_name}}: ', body_html: '<p>Hi {{first_name}},</p><p></p><p>Kind regards,</p>', body_text: '',
      updated_by: profile?.id,
    }).select('id').single();
    if (error) { setErr(error.message); return; }
    await reload(data.id);
    setOpenGroups((s) => new Set([...s, groupKey]));
    setTimeout(() => startEdit({ id: data.id, subject: '{{client_name}}: ', html: '<p>Hi {{first_name}},</p><p></p><p>Kind regards,</p>' }), 0);
  };
  const exec = (cmd, arg) => { document.execCommand(cmd, false, arg); setEditDirty(true); editorRef.current?.focus(); };
  const insertField = (k) => { editorRef.current?.focus(); document.execCommand('insertHTML', false, `${chipHtml(k)}&nbsp;`); setEditDirty(true); };
  const addLink = () => { const url = window.prompt('Link address (https://…)'); if (url) exec('createLink', url); };

  // ── Send ──
  const doSend = async (acknowledged = false) => {
    const body = editorRef.current?.innerHTML || '';
    if (/data-missing=/.test(body)) { setErr('Fill in the amber fields first.'); return; }
    const bodyHtml = body + (signature ? `<br>${signature.body_html}` : '');
    setBusy(true); setErr('');
    try {
      const r = await gmail.queueSend(mailbox, {
        to: to.trim(), cc: cc.trim() || undefined, subject: subject.trim(),
        bodyText: htmlToText(bodyHtml), bodyHtml, acknowledged,
        acknowledgedWarnings: acknowledged ? warnings : undefined,
      });
      setWarnings(null);
      setQueued({ id: r.id, mailbox, secs: 20 });
    } catch (e) {
      if (e.code === 'needs_confirmation') setWarnings(e.warnings || [e.message]);
      else setErr(e.message);
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!queued) return undefined;
    if (queued.secs <= 0) {
      gmail.sendQueued(queued.mailbox, queued.id).catch(() => { /* the outbox cron sends it */ });
      setSent(`Sent to ${to} from ${queued.mailbox}.`);
      setQueued(null); setBodyEdited(false);
      return undefined;
    }
    const t = setTimeout(() => setQueued((x) => (x ? { ...x, secs: x.secs - 1 } : x)), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued]);
  const undo = async () => {
    try { await gmail.cancelQueued(queued.mailbox, queued.id); setQueued(null); } catch (e) { setErr(e.message); }
  };

  const close = () => {
    if ((bodyEdited || editDirty) && !queued && !window.confirm('Close? Your unsent changes will be lost.')) return;
    onClose();
  };

  // ── List ──
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return templates || [];
    return (templates || []).filter((t) => `${t.label} ${t.subject} ${htmlToText(t.html)}`.toLowerCase().includes(needle));
  }, [templates, q]);

  const canSend = sel && !group?.noSend && mode === 'send' && mailbox && to.trim() && subject.trim() && !missing.length && !queued && !busy;
  const lbl = { fontSize: 11.5, fontWeight: 700, color: '#64748b', display: 'block', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.3 };
  const inp = { width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: 13.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 7, background: '#fff' };
  const tb = { border: '1px solid #e2e8f0', background: '#fff', borderRadius: 6, padding: '4px 6px', cursor: 'pointer', display: 'inline-flex', color: '#334155' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, fontFamily: font }}>
      <div style={{ width: 1280, maxWidth: '96vw', height: 'calc(100vh - 40px)', background: '#fff', borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid #e2e8f0' }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>Email templates</span>
          <ClientPicker entity={client?.entity} onPick={(id) => { setEntityId(id); setValues({}); setBodyEdited(false); }} />
          {client?.contacts?.length > 1 && (
            <select value={contactIdx} onChange={(e) => setContactIdx(Number(e.target.value))} style={{ ...inp, width: 230 }} title="Who the email greets">
              {client.contacts.map((c, i) => <option key={i} value={i}>Greet {c.firstName}{c.role ? ` (${c.role})` : ''}</option>)}
            </select>
          )}
          <button onClick={close} style={{ ...BTN.secondary.sm, cursor: 'pointer', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={14} /> Close</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '270px 1fr 290px' }}>
          {/* Left: groups */}
          <div style={{ borderRight: '1px solid #e2e8f0', overflowY: 'auto', padding: 10, background: '#f8fafc' }}>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <Search size={14} style={{ position: 'absolute', left: 8, top: 9, color: '#94a3b8' }} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" style={{ ...inp, paddingLeft: 26 }} />
            </div>
            {!templates && <div style={{ fontSize: 13, color: '#94a3b8', padding: 8 }}>Loading…</div>}
            {templates && GROUPS.map((g) => {
              const items = filtered.filter((t) => t.group === g.key);
              if (q && !items.length) return null;
              const isOpen = q || openGroups.has(g.key);
              return (
                <div key={g.key} style={{ marginBottom: 4 }}>
                  <button onClick={() => setOpenGroups((s) => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', border: 'none', background: 'none', padding: '6px 4px', cursor: 'pointer', fontFamily: font, fontSize: 13.5, fontWeight: 700, color: '#0f172a' }}>
                    <span style={{ width: 14, color: '#94a3b8' }}>{isOpen ? '▾' : '▸'}</span>{g.label}
                    <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 500, color: '#94a3b8' }}>{items.length}</span>
                  </button>
                  {isOpen && items.map((t) => (
                    <button key={t.id} onClick={() => choose(t)}
                      style={{ width: '100%', textAlign: 'left', border: 'none', borderRadius: 6, padding: '5px 8px 5px 22px', cursor: 'pointer', fontFamily: font, fontSize: 13, background: t.id === selId ? '#dbeafe' : 'transparent', color: t.id === selId ? '#1e3a8a' : '#334155' }}>
                      {t.label}
                    </button>
                  ))}
                  {isOpen && !q && (
                    <button onClick={() => newTemplate(g.key)} style={{ border: 'none', background: 'none', padding: '3px 8px 3px 22px', cursor: 'pointer', fontSize: 12, color: '#2563eb', fontFamily: font }}>+ New template</button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Middle: the email */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, padding: 14, gap: 10, overflowY: 'auto' }}>
            {!sel ? (
              <div style={{ margin: 'auto', textAlign: 'center', color: '#64748b', fontSize: 14, maxWidth: 420 }}>
                Pick a template on the left. {client ? `It will be filled in for ${client.entity.name}.` : 'Choose a client at the top and Athena fills in their details.'}
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{sel.label}</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      {group?.label}{sel.description ? ` · ${sel.description}` : ''}{sel.plainText ? ' · Plain text: formatting is not kept.' : ''}
                    </div>
                  </div>
                  {mode === 'send'
                    ? <button onClick={() => startEdit()} style={{ ...BTN.secondary.sm, cursor: 'pointer', marginLeft: 'auto' }}>Edit template</button>
                    : <button onClick={stopEdit} style={{ ...BTN.secondary.sm, cursor: 'pointer', marginLeft: 'auto' }}>Back to sending</button>}
                </div>
                {group?.note && <div style={{ fontSize: 12.5, color: '#92400e', background: '#fffbeb', padding: '6px 10px', borderRadius: 7 }}>{group.note}</div>}

                {mode === 'send' ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div><span style={lbl}>From</span>
                        <select value={mailbox} onChange={(e) => setMailbox(e.target.value)} style={inp}>
                          {mailboxes.map((m) => <option key={m.account_email} value={m.account_email}>{m.account_email}</option>)}
                        </select>
                      </div>
                      <div><span style={lbl}>Signature</span>
                        <select value={sigId} onChange={(e) => setSigId(e.target.value)} style={inp}>
                          <option value="auto">My signature for this mailbox{pickSignature(sigSets, mailbox, 'new') ? ` (${pickSignature(sigSets, mailbox, 'new').name})` : ' (none set)'}</option>
                          {sigSets.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          <option value="none">No signature</option>
                        </select>
                      </div>
                      <div><span style={lbl}>To</span>
                        <input value={to} onChange={(e) => setTo(e.target.value)} list="tpl-to" style={inp} />
                        <datalist id="tpl-to">
                          {client?.contacts?.filter((c) => c.email).map((c) => <option key={c.email} value={c.email}>{c.fullName}</option>)}
                          {client?.entity?.billing_email && <option value={client.entity.billing_email}>Billing email</option>}
                        </datalist>
                      </div>
                      <div><span style={lbl}>Cc</span><input value={cc} onChange={(e) => setCc(e.target.value)} style={inp} /></div>
                    </div>
                    <div><span style={lbl}>Subject</span><input value={subject} onChange={(e) => { setSubject(e.target.value); setSubjectEdited(true); }} style={inp} /></div>
                    <div style={{ flex: 1, minHeight: 240, display: 'flex', flexDirection: 'column' }}>
                      <span style={lbl}>Email {bodyEdited && <button onClick={() => { setBodyEdited(false); }} style={{ border: 'none', background: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 11.5, textTransform: 'none', letterSpacing: 0 }}>· undo my edits and refill from the fields</button>}</span>
                      <div ref={editorRef} contentEditable suppressContentEditableWarning onInput={() => setBodyEdited(true)}
                        style={{ flex: 1, minHeight: 200, overflowY: 'auto', padding: '12px 14px', border: '1px solid #cbd5e1', borderRadius: 7, fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 14, color: '#111', outline: 'none' }} />
                      {signature && (
                        <div style={{ marginTop: 6, padding: '8px 14px', border: '1px dashed #e2e8f0', borderRadius: 7, opacity: 0.8 }}>
                          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Signature (added when sent)</div>
                          <div dangerouslySetInnerHTML={{ __html: signature.body_html }} style={{ fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 13 }} />
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div><span style={lbl}>Subject</span><input value={editSubject} onChange={(e) => { setEditSubject(e.target.value); setEditDirty(true); }} style={inp} /></div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')} title="Bold" style={tb}><Bold size={14} /></button>
                      <button onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')} title="Italic" style={tb}><Italic size={14} /></button>
                      <button onMouseDown={(e) => e.preventDefault()} onClick={() => exec('underline')} title="Underline" style={tb}><Underline size={14} /></button>
                      <button onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertUnorderedList')} title="Bullets" style={tb}><List size={14} /></button>
                      <button onMouseDown={(e) => e.preventDefault()} onClick={addLink} title="Link" style={tb}><Link2 size={14} /></button>
                      <select value="" onChange={(e) => { if (e.target.value) insertField(e.target.value); }} style={{ ...inp, width: 200, marginLeft: 6 }}>
                        <option value="">Insert a field…</option>
                        {Object.entries(FIELDS).filter(([k]) => !['greeting', 'entity', 'opener', 'signoff'].includes(k))
                          .map(([k, m]) => <option key={k} value={k}>{m.label} · {k}</option>)}
                      </select>
                      <span style={{ fontSize: 12, color: '#64748b', marginLeft: 'auto' }}>Grey chips are fields. Your signature is added when sent, so end at the sign-off.</span>
                    </div>
                    <div ref={editorRef} contentEditable suppressContentEditableWarning onInput={() => setEditDirty(true)}
                      style={{ flex: 1, minHeight: 260, overflowY: 'auto', padding: '12px 14px', border: '1px solid #93c5fd', borderRadius: 7, fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 14, color: '#111', outline: 'none' }} />
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button onClick={stopEdit} style={{ ...BTN.secondary.md, cursor: 'pointer' }}>Cancel</button>
                      <button onClick={saveTemplate} disabled={saving || !editDirty} style={{ ...BTN.primary.md, cursor: 'pointer' }}>{saving ? 'Saving…' : 'Save template'}</button>
                    </div>
                  </>
                )}
              </>
            )}

            {warnings && (
              <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: 10, fontSize: 13.5, color: '#92400e' }}>
                {warnings.map((w, i) => <div key={i}>{w}</div>)}
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button onClick={() => doSend(true)} style={{ ...BTN.primary.sm, cursor: 'pointer' }}>Send anyway</button>
                  <button onClick={() => setWarnings(null)} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>Back</button>
                </div>
              </div>
            )}
            {err && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '8px 12px', borderRadius: 8, fontSize: 13.5 }}>{err} <button onClick={() => setErr('')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#b91c1c' }}>×</button></div>}
            {sent && !queued && <div style={{ background: '#f0fdf4', color: '#15803d', padding: '8px 12px', borderRadius: 8, fontSize: 13.5 }}>{sent}</div>}

            {sel && mode === 'send' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
                {missing.length > 0 && !group?.noSend && <span style={{ fontSize: 12.5, color: '#92400e', marginRight: 'auto' }}>Still to fill in: {missing.map((k) => fieldMeta(k).label).join(', ')}</span>}
                {queued ? (
                  <>
                    <span style={{ fontSize: 13.5, color: '#334155' }}>Sending in {queued.secs}s…</span>
                    <button onClick={undo} style={{ ...BTN.secondary.md, cursor: 'pointer' }}>Undo</button>
                  </>
                ) : (
                  <button onClick={() => doSend(false)} disabled={!canSend} style={{ ...BTN.primary.md, cursor: canSend ? 'pointer' : 'default' }}>
                    {group?.noSend ? 'Send from Debt chasing' : busy ? 'Sending…' : `Send from ${(mailbox || '').split('@')[0]}@`}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Right: fields */}
          <div style={{ borderLeft: '1px solid #e2e8f0', overflowY: 'auto', padding: 12, background: '#f8fafc' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 8 }}>Fields</div>
            {!sel && <div style={{ fontSize: 12.5, color: '#94a3b8' }}>The template’s fields appear here.</div>}
            {sel && mode === 'edit' && <div style={{ fontSize: 12.5, color: '#64748b' }}>Insert fields from the toolbar. Values are filled in when the email is sent.</div>}
            {sel && mode === 'send' && fieldKeys.map((k) => {
              const m = fieldMeta(k);
              const auto = m.auto && String(autoValues[k] ?? '') !== '';
              const v = merged[k] ?? '';
              const isMissing = missing.includes(k);
              if (auto && !(k in values)) {
                return (
                  <div key={k} style={{ marginBottom: 8 }}>
                    <span style={{ ...lbl, textTransform: 'none', letterSpacing: 0 }}>{m.label}</span>
                    <div style={{ fontSize: 13, color: '#0f172a', display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      <span style={{ wordBreak: 'break-all' }}>{v}</span>
                      <button onClick={() => setValues((x) => ({ ...x, [k]: v }))} style={{ border: 'none', background: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 11.5, padding: 0, marginLeft: 'auto' }}>change</button>
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>From the client record</div>
                  </div>
                );
              }
              if (m.auto && !(k in values) && !isMissing) return null;
              const set = (val) => { setValues((x) => ({ ...x, [k]: val })); };
              return (
                <div key={k} style={{ marginBottom: 9 }}>
                  <span style={{ ...lbl, textTransform: 'none', letterSpacing: 0, color: isMissing ? '#92400e' : '#64748b' }}>{m.label}</span>
                  {m.kind === 'list' || m.kind === 'long' ? (
                    <textarea value={v} onChange={(e) => set(e.target.value)} rows={m.kind === 'list' ? 4 : 2}
                      placeholder={m.kind === 'list' ? 'One per line' : ''}
                      style={{ ...inp, resize: 'vertical', background: isMissing ? '#fffbeb' : '#fff', borderColor: isMissing ? '#fcd34d' : '#cbd5e1' }} />
                  ) : (
                    <input value={v} onChange={(e) => set(e.target.value)}
                      style={{ ...inp, background: isMissing ? '#fffbeb' : '#fff', borderColor: isMissing ? '#fcd34d' : '#cbd5e1' }} />
                  )}
                  {m.hint && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{m.hint}</div>}
                </div>
              );
            })}
            {sel && mode === 'send' && bodyEdited && (
              <div style={{ fontSize: 11.5, color: '#92400e', marginTop: 6 }}>You’ve edited the email directly, so field changes no longer update it.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ClientPicker({ entity, onPick }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); return undefined; }
    const t = setTimeout(async () => {
      const { data } = await supabase.from('entities').select('id, name, entity_status')
        .ilike('name', `%${term.replace(/[%_]/g, '')}%`).order('name').limit(15);
      setHits(data || []);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div style={{ position: 'relative', width: 320 }}>
      <input value={focus ? q : (entity?.name || q)} onFocus={() => { setFocus(true); setQ(''); }} onBlur={() => setTimeout(() => setFocus(false), 150)}
        onChange={(e) => setQ(e.target.value)} placeholder="Client (type to search)"
        style={{ width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: 13.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 7, fontWeight: entity && !focus ? 600 : 400 }} />
      {focus && hits.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8, boxShadow: '0 8px 24px rgba(15,23,42,.12)', maxHeight: 300, overflowY: 'auto' }}>
          {hits.map((h) => (
            <div key={h.id} onMouseDown={(e) => { e.preventDefault(); onPick(h.id); setFocus(false); setQ(''); }}
              style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 13 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff'; }} onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}>
              {h.name}{h.entity_status && h.entity_status !== 'active' ? <span style={{ color: '#94a3b8' }}> · {h.entity_status}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
