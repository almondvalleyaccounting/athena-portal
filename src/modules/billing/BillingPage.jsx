import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Download, Check, Send, Trash2, Pencil, Minimize2, Maximize2, AlertTriangle, RefreshCw, History, Ban, RotateCcw, ChevronRight, ChevronDown, MessageSquare } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { pushBillingItems, refreshBillingItems, fetchClientInvoices, fetchQboSettings } from '../../lib/qboApi';
import { useAuth } from '../../shell/AppShell';
import NewClientModal from '../../components/NewClientModal';
import ClientTypeAhead from '../work-planner/components/ClientTypeAhead';
import ServicePicker from './ServicePicker';

const VAT_RATE = 0.20;
const STATUS_CONFIG = {
  draft: { label: 'Draft', colour: '#64748b', bg: '#f1f5f9' },
  approved: { label: 'Approved', colour: '#059669', bg: '#f0fdf4' },
  pushed: { label: 'Pushed to QBO', colour: '#0e7fe0', bg: '#eff6ff' },
  rejected: { label: 'Rejected', colour: '#dc2626', bg: '#fef2f2' },
  not_required: { label: 'Not required', colour: '#7c3aed', bg: '#f5f3ff' },
};
// Line services are loaded from qbo_service_items — a service is offered
// only if it maps to a real QBO product, so a bill can no longer be raised
// against a service the push would have to guess at. Maintain the list at
// /manage/billing/products.

export default function BillingPage() {
  const { profile } = useAuth();
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const [highlightActive, setHighlightActive] = useState(!!highlightId);
  const [items, setItems] = useState([]);
  // Internal-only commentary, keyed by billing_item_id. Athena-only: nothing
  // here is read by the QBO push, so it never reaches the client.
  const [comments, setComments] = useState({});
  const [commentDrafts, setCommentDrafts] = useState({}); // per-item box in the thread
  const [commentBusy, setCommentBusy] = useState(null); // item id being posted
  const [entities, setEntities] = useState([]);
  const [services, setServices] = useState([]); // mapped ad-hoc line options: {id, label, category}
  // Each product's standard invoice-line description, as held on the QuickBooks
  // product (sql/187). Picking a service fills an empty Description with it.
  const [serviceDefaults, setServiceDefaults] = useState({});
  const [staffList, setStaffList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pipeline'); // default to pipeline
  const [compact, setCompact] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [expanded, setExpanded] = useState(new Set()); // tiles showing their line detail
  const [showPushConfirm, setShowPushConfirm] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [sendMode, setSendMode] = useState('send'); // bulk default for rows not set individually
  // Per-item send/draft, keyed by billing_item_id. A row only appears here
  // once it's been toggled on its own; everything else follows sendMode.
  const [sendModes, setSendModes] = useState({});
  const [dueDays, setDueDays] = useState(14);
  const [pushResults, setPushResults] = useState(null); // { summary, results } | { error }
  const [preview, setPreview] = useState(null); // dry-run plan rows
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  // Per-item billing contact (email + address), keyed by billing_item_id.
  // Seeded from the dry-run plan's resolved contact, editable before push.
  const [contacts, setContacts] = useState({});
  const [contactIndex, setContactIndex] = useState(0); // which target is being edited
  // Which QBO customer each unmapped client should invoice, keyed by entity_id:
  // a customer id to link, or 'new' to create one. Only clients the dry-run
  // couldn't map appear here — the mapping is a per-client decision, so it's
  // keyed by entity rather than by bill.
  const [custChoice, setCustChoice] = useState({});

  const [formClient, setFormClient] = useState('');
  // Multi-line bill editor. One client, N service lines → one QBO invoice.
  const [formLines, setFormLines] = useState([blankLine()]);
  const [formNote, setFormNote] = useState(''); // internal comment posted on save
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
      const [{ data: bills }, { data: ents }, { data: staff }, { data: svcRows }, { data: cmts }] = await Promise.all([
        supabase.from('billing_items').select('*').order('created_at', { ascending: false }),
        supabase.from('entities').select('id, name').order('name'),
        supabase.from('staff_profiles').select('*').order('name'),
        // Ad-hoc line labels that actually map to a QBO product. Fee-engine
        // service ids are excluded — they're slugs, not something to pick
        // from on a one-off bill.
        supabase.from('qbo_service_items').select('service_id, qbo_item_name, default_description, qbo_category').eq('is_adhoc', true),
        supabase.from('billing_item_comments').select('*').order('created_at'),
      ]);
      setItems(bills || []);
      setComments(groupComments(cmts));
      setEntities(ents || []);
      // The label a line carries IS the service id — it's what resolves to a
      // QBO product on the push. The category only groups the picker.
      setServices((svcRows || [])
        .map((r) => ({ id: r.service_id, label: r.service_id, category: r.qbo_category }))
        .sort((a, b) => a.label.localeCompare(b.label)));
      setServiceDefaults(Object.fromEntries((svcRows || [])
        .filter((r) => r.default_description)
        .map((r) => [r.service_id, r.default_description])));
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
  const resetForm = () => { setFormClient(''); setFormLines([blankLine()]); setFormNote(''); };

  // The bill editor is one modal in two modes: new, or editing the bill whose
  // id is in editingId. The two can't both be open — starting an edit clears
  // the add form and vice versa.
  const formOpen = showAdd || !!editingId;
  const closeForm = () => { setShowAdd(false); setEditingId(null); resetForm(); };

  // Escape closes it — but not while a modal it opened is on top (the
  // past-invoice picker or the new-client form), which would leave the child
  // sitting in front of nothing.
  useEffect(() => {
    if (!formOpen || showInvoicePicker || showNewClient) return;
    const onKey = (e) => { if (e.key === 'Escape') closeForm(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [formOpen, showInvoicePicker, showNewClient]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Internal comments ─────────────────────────────────────────────────────
  // Stays in Athena: the push reads billing_items.lines only, so a comment has
  // no route to QuickBooks or the client.
  const commentsOf = (id) => comments[id] || [];
  const postComment = async (itemId, body) => {
    const text = (body || '').trim();
    if (!text || !itemId) return false;
    setCommentBusy(itemId);
    try {
      const { data, error } = await supabase.from('billing_item_comments')
        .insert({ billing_item_id: itemId, author_id: profile?.id, body: text })
        .select('*').single();
      if (error) throw error;
      setComments((prev) => ({ ...prev, [itemId]: [...(prev[itemId] || []), data] }));
      return true;
    } catch (e) { console.error('[Billing] comment error:', e); return false; }
    finally { setCommentBusy(null); }
  };
  const handleAddComment = async (itemId) => {
    if (!await postComment(itemId, commentDrafts[itemId])) return;
    setCommentDrafts((prev) => ({ ...prev, [itemId]: '' }));
    // A bill with something to say about it should be readable straight away.
    setExpanded((prev) => new Set(prev).add(itemId));
  };
  const handleDeleteComment = async (c) => {
    if (!window.confirm('Delete this comment?')) return;
    try {
      const { error } = await supabase.from('billing_item_comments').delete().eq('id', c.id);
      if (error) throw error;
      setComments((prev) => ({ ...prev, [c.billing_item_id]: (prev[c.billing_item_id] || []).filter((x) => x.id !== c.id) }));
    } catch (e) { console.error('[Billing] comment delete error:', e); }
  };

  // Multi-line editor helpers. Qty × Rate = Amount (see applyCalc); the
  // amount drives VAT (auto 20%) unless the user types a VAT figure
  // (vatManual); gross is always net + VAT.
  const changeLineField = (idx, key, value) => setFormLines((prev) => prev.map((l, i) => i === idx ? { ...l, [key]: value } : l));
  // Picking a service pulls through the standard description held on the
  // QuickBooks product. A description that's empty, or that was filled in this
  // way and not since touched (descAuto), is replaced when the service changes;
  // anything typed by hand stays exactly as typed.
  const changeLineService = (idx, value) => setFormLines((prev) => prev.map((l, i) => {
    if (i !== idx) return l;
    const std = serviceDefaults[value] || '';
    const takeStd = !String(l.description || '').trim() || l.descAuto;
    return { ...l, service: value, description: takeStd ? std : l.description, descAuto: takeStd && !!std };
  }));
  const changeLineDescription = (idx, value) => setFormLines((prev) => prev.map((l, i) => i === idx ? { ...l, description: value, descAuto: false } : l));
  const changeLineCalc = (idx, field, value) => setFormLines((prev) => prev.map((l, i) => i === idx ? applyCalc(l, field, value) : l));
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
      // QBO carries the split, so bring the qty/rate across rather than
      // flattening a "12 × £50" line into a bare £600.
      const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
      const rate = Number(l.unit_price) || (qty ? net / qty : net);
      return {
        service: l.service || '', description: l.description || '',
        qty: net ? fmtNum(qty, 4) : '', rate: net ? fmtNum(rate, 4) : '',
        net: net ? String(net) : '', vat: net ? vat.toFixed(2) : '', gross: net ? (net + vat).toFixed(2) : '',
        vatManual: false, touch: ['qty', 'rate'],
      };
    });
    setFormLines(ls.length ? ls : [blankLine()]);
    // Copying into a bill that's open for editing has to stay an edit.
    // Forcing the Add form here saved a second bill and left the original
    // sitting behind it — a silent duplicate.
    if (!editingId) setShowAdd(true);
    setShowInvoicePicker(false);
  };

  // Per-item billing-contact helpers (push-confirm modal).
  const contactOf = (id) => contacts[id] || { email: '', line1: '', line2: '', city: '', postcode: '' };
  const setContact = (id, patch) => setContacts((prev) => ({ ...prev, [id]: { ...contactOf(id), ...patch } }));
  const isContactReady = (id) => { const c = contactOf(id); return !!(c.email?.trim() && c.line1?.trim() && c.postcode?.trim()); };

  // ── QBO customer mapping (push-confirm modal) ──
  // The dry-run says which QBO customer each bill will land on. Where it
  // couldn't map one, the user picks: link an existing customer or create a
  // new one. Left undecided, the push is blocked rather than guessing —
  // Athena's "Surname, Firstname" rarely matches a trading name in QBO, so
  // an unguarded create makes a duplicate customer.
  const planOf = (itemId) => preview?.find((r) => r.billing_item_id === itemId) || null;
  const custChoiceOf = (entityId) => custChoice[entityId] || '';
  const setCustChoiceFor = (entityId, value) => setCustChoice((prev) => ({ ...prev, [entityId]: value }));
  // Undecided only counts once the dry-run has actually come back.
  const needsCustomerChoice = (item) => {
    const p = planOf(item.id);
    return !!p && p.customer_action === 'create' && !custChoiceOf(item.entity_id);
  };
  // What the row will do, resolved from the plan plus any pick made here.
  const customerTargetOf = (item) => {
    const p = planOf(item.id);
    if (!p) return null;
    if (p.customer_action !== 'create') {
      // A stored id QBO no longer returns is a broken mapping, not a customer.
      if (p.customer_missing) return { mode: 'missing', name: null, id: p.qbo_customer_id, source: p.customer_source, inactive: false };
      return { mode: 'existing', name: p.qbo_customer_name || '(unnamed customer)', id: p.qbo_customer_id, source: p.customer_source, inactive: p.customer_inactive };
    }
    const choice = custChoiceOf(item.entity_id);
    if (choice && choice !== 'new') {
      const c = (p.customer_candidates || []).find((x) => String(x.id) === String(choice));
      return { mode: 'link', name: c?.name || `Customer ${choice}`, id: choice, source: 'picked', inactive: c ? !c.active : false };
    }
    if (choice === 'new') return { mode: 'new', name: entityMap[item.entity_id]?.name || '—', id: null, source: null, inactive: false };
    return { mode: 'undecided', name: null, id: null, source: null, inactive: false };
  };
  // Send/draft resolves per item: its own choice if it has one, else the bulk
  // default. An item with no email can only ever be a draft.
  const sendModeOf = (id) => sendModes[id] || sendMode;
  const willSendItem = (id) => sendModeOf(id) === 'send' && !!contactOf(id).email?.trim();
  const setSendModeFor = (id, mode) => setSendModes((prev) => ({ ...prev, [id]: mode }));
  // The bulk buttons are a "set everything to this" action, not a separate
  // setting — otherwise a per-row choice made earlier would silently survive.
  const setAllSendModes = (mode) => { setSendMode(mode); setSendModes({}); };

  // Turn the editor rows into the stored line array + invoice totals + a
  // short `service` summary for the list view.
  const buildLinesPayload = () => {
    const lines = formLines
      .filter((l) => l.service && l.net !== '')
      .map((l) => {
        const net = parseFloat(l.net) || 0;
        const vat = l.vat !== '' ? (parseFloat(l.vat) || 0) : Math.round(net * VAT_RATE * 100) / 100;
        const gross = Math.round((net + vat) * 100) / 100;
        // Only keep the qty/rate split if it actually multiplies out to the
        // amount — a stale pair would put a line on the QBO invoice that
        // doesn't agree with what was approved here.
        const q = parseFloat(l.qty), r = parseFloat(l.rate);
        const split = Number.isFinite(q) && q > 0 && Number.isFinite(r) && Math.abs(q * r - net) < 0.005;
        return {
          service: l.service, description: l.description.trim() || null,
          qty: split ? q : 1, rate: split ? r : net,
          net, vat, gross,
        };
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
      const { data: created, error } = await supabase.from('billing_items').insert({
        entity_id: formClient, service: summary, description: null,
        net_amount: totals.net, vat_amount: totals.vat, gross_amount: totals.gross,
        lines, status: 'draft', created_by: profile?.id,
      }).select('id').single();
      if (error) throw error;
      // The note typed alongside the bill becomes its first comment.
      if (formNote.trim() && created?.id) await postComment(created.id, formNote);
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
      if (formNote.trim()) await postComment(item.id, formNote);
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
  // A £0.00 placeholder can't be approved (see isPriced), so this only catches
  // rows approved before that rule existed — but a £0.00 invoice must never
  // reach QuickBooks, so it's checked at the terminal step too.
  const unpricedTargets = pushTargets.filter((i) => !isPriced(i));
  // Clients with no QBO customer mapped and no decision made yet.
  const unmappedTargets = pushTargets.filter((i) => needsCustomerChoice(i));
  const allContactsReady = pushTargets.length > 0 && notReadyTargets.length === 0 && unpricedTargets.length === 0 && unmappedTargets.length === 0;
  // How the batch currently splits, for the bulk buttons and the submit label.
  const sendCount = pushTargets.filter((i) => willSendItem(i.id)).length;
  const draftCount = pushTargets.length - sendCount;
  const mixedSend = sendCount > 0 && draftCount > 0;

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

      // Resolve every row explicitly rather than relying on the bulk flag, so
      // what the modal showed is exactly what the push does.
      const sendMap = {};
      for (const it of pushTargets) sendMap[it.id] = sendModeOf(it.id) === 'send';

      // Customer mapping decisions, per client. Only unmapped clients appear:
      // either link the customer the user picked, or carry the explicit
      // go-ahead to create one. The push rejects anything else.
      const linkCustomer = {};
      const newCustomerOk = {};
      for (const it of pushTargets) {
        const t = customerTargetOf(it);
        if (!t || !it.entity_id) continue;
        if (t.mode === 'link') linkCustomer[it.entity_id] = String(t.id);
        else if (t.mode === 'new') newCustomerOk[it.entity_id] = true;
      }

      const result = await pushBillingItems(
        pushTargets.map((i) => i.id),
        sendMode === 'send',
        profile?.id,
        false,
        Number(dueDays) >= 0 ? Number(dueDays) : 14,
        sendMap,
        { linkCustomer, newCustomerOk },
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
    if (!showPushConfirm) { setPreview(null); setPreviewError(null); setContacts({}); setContactIndex(0); setSendModes({}); setCustChoice({}); return; }
    let cancelled = false;
    const ids = pushTargets.map((i) => i.id);
    if (ids.length === 0) return;
    setPreviewLoading(true); setPreviewError(null);
    pushBillingItems(ids, true, profile?.id, true)
      .then((res) => {
        if (cancelled) return;
        const plan = res?.plan || [];
        setPreview(plan);
        // A client with no QBO customer AND no near matches is unambiguous —
        // default it to "create". Where QBO does hold something similar the
        // choice stays blank, so the push waits for the user to look at it.
        setCustChoice((prev) => {
          const next = { ...prev };
          for (const p of plan) {
            if (p.customer_action !== 'create' || !p.entity_id || next[p.entity_id]) continue;
            if (!(p.customer_candidates || []).length) next[p.entity_id] = 'new';
          }
          return next;
        });
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
    setFormNote(''); // the note box is always a fresh comment, never an edit of an old one
    // A stored VAT figure only counts as "manual" if it differs from the
    // standard rate — otherwise editing Net must keep auto-recalculating VAT.
    const isManualVat = (net, vat) => {
      const netNum = parseFloat(net) || 0; const vatNum = parseFloat(vat) || 0;
      return Math.abs(vatNum - Math.round(netNum * VAT_RATE * 100) / 100) > 0.005;
    };
    // Load the stored lines, or build a single line from the legacy fields.
    // A stored line's qty/rate are treated as the pair you last set, so
    // editing either one moves the amount (rather than re-splitting it).
    const ls = Array.isArray(item.lines) && item.lines.length
      ? item.lines.map((l) => ({
          service: l.service || '', description: l.description || '',
          ...splitOf(l.qty, l.rate, l.net),
          net: l.net != null ? String(l.net) : '', vat: l.vat != null ? String(l.vat) : '',
          gross: l.gross != null ? String(l.gross) : '', vatManual: isManualVat(l.net, l.vat),
          touch: ['qty', 'rate'],
        }))
      : [{
          service: item.service || '', description: item.description || '',
          ...splitOf(null, null, item.net_amount),
          net: String(item.net_amount || ''), vat: String(item.vat_amount || ''),
          gross: String(item.gross_amount || ''), vatManual: isManualVat(item.net_amount, item.vat_amount),
          touch: ['qty', 'rate'],
        }];
    setFormLines(ls.length ? ls : [blankLine()]);
  };

  const toggleExpand = (id) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
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

  // The bill editor's innards. Always shown inside the modal below — editing
  // used to load the bill into a panel at the top of the page, which read as
  // "nothing happened" unless you knew to scroll up.
  const renderForm = (onSubmit, submitLabel, onCancel) => (
    <div>
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
        <span style={formLabel}>Qty</span><span style={formLabel}>Rate (£)</span>
        <span style={formLabel}>Amount (£) *</span><span style={formLabel}>VAT (£)</span><span style={formLabel}>Gross (£)</span><span/>
      </div>
      {formLines.map((l,idx)=>(
        <div key={idx} style={{display:'grid',gridTemplateColumns:LINE_COLS,gap:8,marginBottom:6,alignItems:'flex-start'}}>
          {/* Searchable and grouped by QuickBooks category. A service the line
              already carries but that isn't in the list — copied from a QBO
              invoice, or unmapped since this bill was drafted — is kept and
              flagged, so editing an old bill can't silently blank its line. */}
          <ServicePicker
            value={l.service}
            options={services}
            onChange={(v)=>changeLineService(idx,v)}
            style={inputStyle}
          />
          {/* Textarea so multi-line QBO descriptions keep their line breaks. */}
          <textarea
            value={l.description}
            onChange={(e)=>changeLineDescription(idx,e.target.value)}
            placeholder={serviceDefaults[l.service] ? 'Standard description — type over it if this one differs' : 'Optional...'}
            title={l.descAuto ? "The QuickBooks product's standard description — edit it freely" : undefined}
            rows={2}
            style={{...inputStyle,resize:'vertical',minHeight:38,lineHeight:1.4,color:l.descAuto?'#475569':undefined}}
          />
          <CalcInput value={l.qty} onChange={(v)=>changeLineCalc(idx,'qty',v)} dp={4} placeholder="1" style={numInput}/>
          <CalcInput value={l.rate} onChange={(v)=>changeLineCalc(idx,'rate',v)} dp={4} placeholder="0.00" style={numInput}/>
          <CalcInput value={l.net} onChange={(v)=>changeLineCalc(idx,'net',v)} dp={2} placeholder="0.00" style={numInput}/>
          <CalcInput value={l.vat} onChange={(v)=>changeLineVat(idx,v)} dp={2} placeholder="0.00" style={numInput}/>
          <input value={l.gross} placeholder="0.00" style={{...numInput,background:'#f8fafc'}} readOnly/>
          <button onClick={()=>removeLine(idx)} disabled={formLines.length===1} title="Remove line"
            style={{background:'none',border:'none',cursor:formLines.length===1?'default':'pointer',padding:4,opacity:formLines.length===1?0.3:1,display:'inline-flex'}}>
            <Trash2 size={15} style={{color:'#94a3b8'}}/>
          </button>
        </div>
      ))}
      <div style={{display:'flex',alignItems:'center',gap:12,marginTop:2}}>
        <button onClick={addLine} style={{...btnOutline,gap:5,flexShrink:0,whiteSpace:'nowrap'}}><Plus size={14}/> Add line</button>
        <span style={{fontSize:11,color:'#94a3b8'}}>
          Qty × Rate = Amount — fill in any two and the third works itself out. Sums work too: type <code style={calcHint}>100*10</code> then Tab.
          {' '}Not sure of the figure yet? Put <b>0</b> in Amount — it saves as a £0.00 placeholder and can&apos;t be approved until it&apos;s priced.
        </span>
      </div>

      {/* Internal comment. Context for whoever reviews the bill — what the work
          actually was, why it's being charged, anything odd about the amount.
          Never leaves Athena. */}
      <div style={{marginTop:16,borderTop:'1px solid #f1f5f9',paddingTop:12}}>
        <label style={formLabel}>
          <span style={{display:'inline-flex',alignItems:'center',gap:5}}><MessageSquare size={12}/> Comment for whoever reviews this</span>
        </label>
        {/* When editing, show what's already been said so the same thing isn't
            typed twice — and so a reply reads in context. */}
        {editingId && commentsOf(editingId).length > 0 && (
          <div style={{marginBottom:8,display:'flex',flexDirection:'column',gap:6}}>
            {commentsOf(editingId).map((c)=>(
              <div key={c.id} style={{fontSize:12,color:'#475569',background:'#f8fafc',borderRadius:8,padding:'7px 10px',whiteSpace:'pre-line'}}>
                <span style={{fontWeight:600,color:'#0f172a'}}>{staffMap[c.author_id]?.name||'Unknown'}</span>
                <span style={{color:'#94a3b8',fontSize:11}}> · {commentDate(c.created_at)}</span>
                <div>{c.body}</div>
              </div>
            ))}
          </div>
        )}
        <textarea
          value={formNote}
          onChange={(e)=>setFormNote(e.target.value)}
          rows={2}
          placeholder="e.g. rebuilt 14 months of bookkeeping after the old bookkeeper left — agreed with the client on the call"
          style={{...inputStyle,resize:'vertical',minHeight:44,lineHeight:1.5}}
        />
        <p style={{fontSize:11,color:'#94a3b8',marginTop:4}}>
          Internal only — stays in Athena. It isn&apos;t sent to QuickBooks and the client never sees it. Use the line <b>Description</b> above for anything that should appear on the invoice.
        </p>
      </div>

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
    <div style={{maxWidth:1080,margin:'0 auto',padding:'32px 24px',fontFamily:"'Outfit', sans-serif"}}>
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

      {/* Add / edit a bill — a modal, so clicking Edit puts the bill in front of
          you instead of loading a panel above the fold. z-index sits under the
          new-client and past-invoice modals (both 1000), which open from
          inside this one. */}
      {formOpen && (
        <div style={{position:'fixed',inset:0,zIndex:900,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'flex-start',justifyContent:'center',padding:'32px 24px',overflowY:'auto'}}>
          {/* No close-on-backdrop-click: a stray click shouldn't throw away a
              half-typed bill. Cancel, the ×, or Escape close it. */}
          <div style={{background:'#fff',borderRadius:16,padding:'24px 28px 22px',maxWidth:1000,width:'100%',boxShadow:'0 20px 60px rgba(0,0,0,0.18)',margin:'auto 0'}}>
            <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12,marginBottom:16}}>
              <div>
                <h2 style={{fontFamily:"'Playfair Display', serif",fontSize:20,fontWeight:500,color:'#0f172a',margin:0}}>
                  {editingId ? 'Edit bill' : 'New bill'}
                </h2>
                <p style={{fontSize:12,color:'#94a3b8',margin:'3px 0 0'}}>
                  {editingId
                    ? `${entityMap[items.find((i)=>i.id===editingId)?.entity_id]?.name || 'Client'} — one invoice per bill, one line per thing being charged`
                    : 'One client per bill — it becomes one QuickBooks invoice with a line per service'}
                </p>
              </div>
              <button onClick={closeForm} title="Close (Esc)" style={{background:'none',border:'none',cursor:'pointer',padding:4,display:'inline-flex',color:'#94a3b8',fontSize:20,lineHeight:1,fontFamily:"'Outfit', sans-serif"}}>×</button>
            </div>
            {editingId
              ? renderForm(()=>handleUpdate(items.find((i)=>i.id===editingId)), 'Save', closeForm)
              : renderForm(handleAdd, 'Add', closeForm)}
          </div>
        </div>
      )}

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
            const isOpen = expanded.has(item.id);
            // The team types descriptions per line, so the item-level
            // description is usually empty — fall back to the lines rather
            // than showing "No description" on a bill that has plenty.
            const lines = itemLines(item);
            const cmts = commentsOf(item.id);
            const descPreview = item.description || lines.map((l)=>l.description).filter(Boolean).join(' · ');
            // Stop the checkbox and the action buttons from also toggling
            // the expander they sit inside.
            const swallow = (e)=>e.stopPropagation();

            if (compact) return (
              <div key={item.id} id={`billing-item-${item.id}`} style={{background:isHighlighted?'#eff6ff':isSelected?'#eff6ff':'#fff',borderRadius:8,overflow:'hidden',border:`1px solid ${isSelected?'#0e7fe0':'#e5e7eb'}`,borderLeft:`3px solid ${sc.colour}`,boxShadow:isHighlighted?'0 0 0 3px rgba(14,127,224,0.35)':'none',transition:'box-shadow 0.3s ease'}}>
                <div onClick={()=>toggleExpand(item.id)} title={isOpen?'Hide detail':'Show the line detail'} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 12px',fontSize:12,cursor:'pointer'}}>
                  <span onClick={swallow} style={{display:'inline-flex',flexShrink:0}}>
                    <input type="checkbox" checked={isSelected} onChange={()=>toggleSelect(item.id)} style={{width:13,height:13,cursor:'pointer',accentColor:'#0e7fe0'}}/>
                  </span>
                  {isOpen?<ChevronDown size={13} style={{color:'#94a3b8',flexShrink:0}}/>:<ChevronRight size={13} style={{color:'#cbd5e1',flexShrink:0}}/>}
                  <span style={{fontWeight:500,color:'#0f172a',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{clientName} — {[descPreview, item.service].filter(Boolean).join(' · ') || item.service}</span>
                  <span style={{fontWeight:600,color:'#0f172a',flexShrink:0}}>{fmt(item.gross_amount)}</span>
                  <CommentTag count={cmts.length} compact/>
                  <UnpricedTag item={item} compact/>
                  <span style={{fontSize:10,fontWeight:600,color:sc.colour,background:sc.bg,padding:'2px 6px',borderRadius:4,flexShrink:0}}>{sc.label}</span>
                  <QboInvoiceTag item={item}/>
                  <span style={{fontSize:10,color:'#94a3b8',flexShrink:0}}>{addedBy} · {dateStr}</span>
                  <span onClick={swallow} style={{display:'inline-flex',flexShrink:0}}>
                    <ActionButtons item={item} onEdit={()=>startEdit(item)} onDelete={()=>handleDelete(item)} onStatus={handleStatusChange} compact/>
                  </span>
                </div>
                {isOpen && (
                  <>
                    <BillLines lines={lines} fmt={fmt}/>
                    <BillComments
                      comments={cmts} staffMap={staffMap} meId={profile?.id}
                      draft={commentDrafts[item.id]||''}
                      onDraft={(v)=>setCommentDrafts((prev)=>({...prev,[item.id]:v}))}
                      onAdd={()=>handleAddComment(item.id)}
                      onDelete={handleDeleteComment}
                      busy={commentBusy===item.id}
                    />
                  </>
                )}
              </div>
            );

            return (
              <div key={item.id} id={`billing-item-${item.id}`} style={{background:isSelected?'#eff6ff':'#fff',borderRadius:12,overflow:'hidden',border:`1px solid ${isSelected?'#0e7fe0':'#e5e7eb'}`,borderLeft:`3px solid ${sc.colour}`,boxShadow:isHighlighted?'0 0 0 3px rgba(14,127,224,0.35)':'none',transition:'box-shadow 0.3s ease'}}>
                <div onClick={()=>toggleExpand(item.id)} title={isOpen?'Hide detail':'Show the line detail'} style={{display:'flex',alignItems:'flex-start',gap:12,padding:'14px 18px',cursor:'pointer'}}>
                  <span onClick={swallow} style={{display:'inline-flex',marginTop:3,flexShrink:0}}>
                    <input type="checkbox" checked={isSelected} onChange={()=>toggleSelect(item.id)} style={{width:14,height:14,cursor:'pointer',accentColor:'#0e7fe0'}}/>
                  </span>
                  <span style={{marginTop:3,flexShrink:0,display:'inline-flex'}}>
                    {isOpen?<ChevronDown size={14} style={{color:'#94a3b8'}}/>:<ChevronRight size={14} style={{color:'#cbd5e1'}}/>}
                  </span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:500,color:'#0f172a',marginBottom:2}}>{clientName}</div>
                    <div style={{fontSize:12,color:'#64748b',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:isOpen?'normal':'nowrap'}}>
                      {descPreview || <span style={{fontStyle:'italic',color:'#cbd5e1'}}>No description</span>}
                      {item.service && <span style={{color:'#0f172a',fontWeight:500}}> · {item.service}</span>}
                    </div>
                    <div style={{fontSize:11,color:'#94a3b8',marginTop:4,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                      <span style={{fontSize:10,fontWeight:600,color:sc.colour,background:sc.bg,padding:'2px 8px',borderRadius:6}}>{sc.label}</span>
                      <QboInvoiceTag item={item}/>
                      <CommentTag count={cmts.length}/>
                      <UnpricedTag item={item}/>
                      <span>Added by {addedBy}</span>
                      <span>{dateStr}</span>
                      {lines.length>1 && <span>{lines.length} lines</span>}
                    </div>
                  </div>
                  <div style={{textAlign:'right',flexShrink:0}}>
                    <div style={{fontSize:16,fontWeight:700,color:'#0f172a'}}>{fmt(item.gross_amount)}</div>
                    <div style={{fontSize:10,color:'#64748b'}}>{fmt(item.net_amount)} + {fmt(item.vat_amount)} VAT</div>
                  </div>
                  <span onClick={swallow} style={{display:'inline-flex',flexShrink:0}}>
                    <ActionButtons item={item} onEdit={()=>startEdit(item)} onDelete={()=>handleDelete(item)} onStatus={handleStatusChange}/>
                  </span>
                </div>
                {isOpen && (
                  <>
                    <BillLines lines={lines} fmt={fmt}/>
                    <BillComments
                      comments={cmts} staffMap={staffMap} meId={profile?.id}
                      draft={commentDrafts[item.id]||''}
                      onDraft={(v)=>setCommentDrafts((prev)=>({...prev,[item.id]:v}))}
                      onAdd={()=>handleAddComment(item.id)}
                      onDelete={handleDeleteComment}
                      busy={commentBusy===item.id}
                    />
                  </>
                )}
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

            {/* Send mode — bulk setter. Each row can still be flipped
                individually in the Send column of the list below. */}
            <div style={{display:'flex',gap:8,marginBottom:16}}>
              <button onClick={()=>setAllSendModes('send')} style={{...modeBtn, ...(sendMode==='send'&&!mixedSend?modeBtnActive:{})}}>
                <div style={{fontWeight:600,fontSize:13}}>Send all now</div>
                <div style={{fontSize:11,color:'#64748b'}}>Email every invoice to the client immediately</div>
              </button>
              <button onClick={()=>setAllSendModes('draft')} style={{...modeBtn, ...(sendMode==='draft'&&!mixedSend?modeBtnActive:{})}}>
                <div style={{fontWeight:600,fontSize:13}}>All as drafts</div>
                <div style={{fontSize:11,color:'#64748b'}}>Don&apos;t send — you&apos;ll send these from QBO later</div>
              </button>
            </div>

            {/* The invoices being pushed. Top of the modal: this is the thing
                being confirmed, and the Send column is where each one is set
                to email now or hold as a draft. */}
            <div style={{background:'#f8fafc',borderRadius:8,padding:'8px 14px',marginBottom:20,maxHeight:380,overflowY:'auto'}}>
              {previewLoading && <div style={{fontSize:12,color:'#94a3b8',padding:'4px 0'}}>Checking QuickBooks…</div>}
              {previewError && <div style={{fontSize:12,color:'#b91c1c',padding:'4px 0'}}>Couldn&apos;t load preview: {previewError}</div>}
              {/* Header */}
              <div style={{display:'grid',gridTemplateColumns:INVOICE_COLS,gap:10,padding:'4px 0',fontSize:10,fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.04em',borderBottom:'1px solid #e5e7eb'}}>
                <span>Client</span><span>Service</span><span>Type</span><span>QuickBooks customer</span><span>Send</span>
                <span style={{textAlign:'right'}}>Net</span><span style={{textAlign:'right'}}>VAT</span><span style={{textAlign:'right'}}>Gross</span>
              </div>
              {pushTargets.map((item,idx)=>{
                const p = preview?.find((r)=>r.billing_item_id===item.id);
                // Send/ready derive from the LIVE edited contact, not the
                // pre-edit dry-run, so the row reflects gaps the user is fixing.
                const cc = contactOf(item.id);
                const liveEmail = cc.email?.trim();
                const ready = isContactReady(item.id);
                const mode = sendModeOf(item.id);
                const willSend = willSendItem(item.id);
                const isCurrent = Math.min(contactIndex,pushTargets.length-1)===idx;
                return (
                  <div key={item.id} onClick={()=>setContactIndex(idx)} style={{display:'grid',gridTemplateColumns:INVOICE_COLS,gap:10,alignItems:'center',padding:'7px 4px',borderBottom:'1px solid #f1f5f9',fontSize:12,cursor:'pointer',background:isCurrent?'#eff6ff':'transparent',borderRadius:6}}>
                    <span style={ellip} title={entityMap[item.entity_id]?.name}>{!ready && <span style={{color:'#b45309'}} title="Needs email + address">⚠ </span>}{entityMap[item.entity_id]?.name||'—'}</span>
                    <span style={{...ellip,color:(p?.unmapped?.length>0)?'#b45309':'#475569'}} title={(p?.unmapped?.length>0)?`No QuickBooks product mapped for: ${p.unmapped.join(', ')} — map it (qbo_service_items) before pushing or this line will error`:(item.description||item.service)}>{(p?.unmapped?.length>0)?<span title="Service not mapped to a QuickBooks product">⚠ </span>:null}{item.service}</span>
                    <span style={{color:'#64748b'}}>One-off</span>
                    {/* Which QBO customer this invoice lands on, BY NAME.
                        "Existing" alone hid the thing worth checking: the
                        Athena client and the QBO customer are often named
                        differently (trading names), and that's only spottable
                        if the name is on screen before the push. */}
                    {(() => {
                      const t = customerTargetOf(item);
                      if (!p || !t) return <span style={{color:'#94a3b8'}}>…</span>;
                      if (t.mode==='undecided') return <span style={{...ellip,color:'#b45309',fontWeight:600}} title="No QuickBooks customer mapped — pick one below before pushing">⚠ Not mapped</span>;
                      if (t.mode==='missing') return <span style={{...ellip,color:'#b91c1c',fontWeight:600}} title={`This client is mapped to QuickBooks customer #${t.id}, which QuickBooks no longer returns. The push will fail on it — fix the mapping on the client record.`}>⚠ #{t.id} not in QBO</span>;
                      if (t.mode==='new') return <span style={{...ellip,color:'#b45309',fontWeight:500}} title={`Will create a new QuickBooks customer: ${t.name}`}>New · {t.name}</span>;
                      const via = t.source==='picked' ? 'linking to this customer now'
                        : t.source==='name_match' ? 'matched on name — not yet stored against the client'
                        : 'stored mapping on the client record';
                      return (
                        <span style={{...ellip,color:'#475569',fontWeight:500}} title={`Invoice goes to QuickBooks customer "${t.name}"${t.id?` (#${t.id})`:''} — ${via}${t.inactive?' · this customer is INACTIVE in QuickBooks':''}`}>
                          {t.inactive && <span style={{color:'#b45309'}} title="Inactive in QuickBooks">⚠ </span>}{t.name}
                        </span>
                      );
                    })()}
                    {/* Per-item send/draft. Clicking must not also move the
                        contact editor, hence stopPropagation. */}
                    <span onClick={(e)=>e.stopPropagation()} style={{display:'flex',alignItems:'center',gap:4,minWidth:0}}>
                      <span style={{display:'inline-flex',border:'1px solid #e5e7eb',borderRadius:6,overflow:'hidden',flexShrink:0}}>
                        <button
                          onClick={()=>setSendModeFor(item.id,'send')}
                          disabled={pushing||!liveEmail}
                          title={liveEmail?`Email this invoice to ${liveEmail} on push`:'Needs an email before it can be sent'}
                          style={{...sendToggleBtn, ...(mode==='send'&&liveEmail?sendToggleSend:{}), opacity:liveEmail?1:0.4, cursor:liveEmail?'pointer':'not-allowed'}}
                        >Send</button>
                        <button
                          onClick={()=>setSendModeFor(item.id,'draft')}
                          disabled={pushing}
                          title="Create it in QuickBooks but don't email it"
                          style={{...sendToggleBtn, borderLeft:'1px solid #e5e7eb', ...(mode==='draft'||!liveEmail?sendToggleDraft:{})}}
                        >Draft</button>
                      </span>
                      {willSend && <span style={{...ellip,color:'#059669',fontSize:11}} title={liveEmail}>→ {liveEmail}</span>}
                      {mode==='send' && !liveEmail && <span style={{color:'#b45309',fontSize:11}} title="No email on file — this will be created as a draft">no email</span>}
                    </span>
                    <span style={{textAlign:'right',fontFamily:'monospace',color:'#64748b'}}>{fmt(item.net_amount)}</span>
                    <span style={{textAlign:'right',fontFamily:'monospace',color:'#64748b'}}>{fmt(item.vat_amount)}</span>
                    <span title={isPriced(item)?undefined:"No amount on this bill yet — it can't be pushed"} style={{textAlign:'right',fontFamily:'monospace',fontWeight:600,color:isPriced(item)?'#0f172a':'#b45309'}}>{isPriced(item)?fmt(item.gross_amount):'⚠ £0.00'}</span>
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

                  {/* QuickBooks customer — stated plainly, because the email
                      and address below get written onto THIS customer record,
                      not just onto the invoice. */}
                  {(() => {
                    const t = customerTargetOf(curTarget);
                    if (!cp || !t) return null;
                    const cands = cp.customer_candidates || [];
                    const mapped = t.mode==='existing' || t.mode==='link';
                    const tone = t.mode==='missing' ? {bg:'#fef2f2',br:'#fecaca'} : mapped ? {bg:'#f0f9ff',br:'#bae6fd'} : {bg:'#fffbeb',br:'#fde68a'};
                    return (
                      <div style={{marginBottom:10,padding:'8px 10px',borderRadius:8,background:tone.bg,border:`1px solid ${tone.br}`}}>
                        <label style={{...formLabel,marginBottom:4}}>QuickBooks customer</label>
                        {t.mode==='missing' ? (
                          <div style={{fontSize:12,color:'#b91c1c'}}>
                            This client is mapped to QuickBooks customer <b>#{t.id}</b>, which QuickBooks no longer returns — it may have been deleted or merged. Clear or correct the mapping on the client record before pushing; this bill will error otherwise.
                          </div>
                        ) : mapped ? (
                          <>
                            <div style={{fontSize:13,fontWeight:600,color:'#0f172a'}}>
                              {t.name}{t.id && <span style={{fontWeight:400,color:'#64748b'}}> · #{t.id}</span>}
                            </div>
                            <div style={{fontSize:11,color:'#64748b',marginTop:2}}>
                              {t.source==='stored' ? 'Mapped on the client record'
                                : t.source==='name_match' ? 'Matched on name'
                                : 'Will be linked to this client on push'}
                              {t.name && t.name.toLowerCase() !== name.toLowerCase() && ' — note the QuickBooks name differs from the Athena name'}
                              {t.inactive && ' · inactive in QuickBooks'}
                            </div>
                            <div style={{fontSize:11,color:'#64748b',marginTop:4}}>The email and address below are saved onto this customer in QuickBooks, so they apply to its future invoices too.</div>
                          </>
                        ) : (
                          <>
                            <div style={{fontSize:12,color:'#92400e',marginBottom:6}}>
                              No QuickBooks customer is mapped to <b>{name}</b>.
                              {cands.length>0 ? ` ${cands.length} similar ${cands.length===1?'customer':'customers'} already exist — link the right one rather than creating a duplicate.` : ' Nothing similar found in QuickBooks.'}
                            </div>
                            <select
                              value={custChoiceOf(curTarget.entity_id)}
                              onChange={(e)=>setCustChoiceFor(curTarget.entity_id,e.target.value)}
                              disabled={pushing}
                              style={{...inputStyle,marginBottom:0}}
                            >
                              <option value="">Choose the QuickBooks customer…</option>
                              {cands.map((c)=>(
                                <option key={c.id} value={c.id}>
                                  Link to: {c.name}{c.active?'':' (inactive)'}{c.address_label?` — ${c.address_label}`:''}
                                </option>
                              ))}
                              <option value="new">Create a new customer called &quot;{name}&quot;</option>
                            </select>
                          </>
                        )}
                      </div>
                    );
                  })()}

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
            {notReadyTargets.length>0 && pushTargets.length>0 && !previewLoading && (
              <p style={{fontSize:12,color:'#b45309',marginBottom:8}}>
                {notReadyTargets.length} {notReadyTargets.length===1?'item needs':'items need'} an email + address (line 1 + postcode) before you can push.
              </p>
            )}
            {unmappedTargets.length>0 && !previewLoading && (
              <p style={{fontSize:12,color:'#b45309',marginBottom:8}}>
                {unmappedTargets.length===1?'1 client has':`${unmappedTargets.length} clients have`} no QuickBooks customer mapped ({unmappedTargets.map((i)=>entityMap[i.entity_id]?.name||'—').join(', ')}). Pick the customer to link — or confirm a new one — in the billing contact panel above.
              </p>
            )}
            {unpricedTargets.length>0 && (
              <p style={{fontSize:12,color:'#b45309',marginBottom:8}}>
                {unpricedTargets.length} {unpricedTargets.length===1?'item has':'items have'} no amount yet (£0.00). Price {unpricedTargets.length===1?'it':'them'} or mark {unpricedTargets.length===1?'it':'them'} not required — a £0.00 invoice can&apos;t go to QuickBooks.
              </p>
            )}
            <div style={{display:'flex',gap:10}}>
              <button onClick={()=>{setShowPushConfirm(false);setPushResults(null);}} style={{...btnOutline,flex:1}}>{pushResults && !pushResults.error ? 'Close' : 'Cancel'}</button>
              <button onClick={handleBatchPush} disabled={pushing || !allContactsReady} style={{...btnPrimary,flex:1,background:'#059669',justifyContent:'center',opacity:(pushing||!allContactsReady)?0.5:1}}>
                {pushing ? 'Pushing...'
                  : mixedSend ? `Send ${sendCount} · draft ${draftCount}`
                  : sendCount > 0 ? `Create & send ${sendCount}`
                  : `Create ${draftCount} draft${draftCount!==1?'s':''}`}
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

// The line detail behind a tile — what the team actually typed, without
// having to open the bill for editing.
function BillLines({ lines, fmt }) {
  return (
    <div style={{ borderTop: '1px solid #f1f5f9', background: '#fafafa', padding: '8px 18px 10px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: DETAIL_COLS, gap: 10, padding: '2px 0 4px', fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #eef2f7' }}>
        <span>Service</span><span>Description</span>
        <span style={{ textAlign: 'right' }}>Qty</span><span style={{ textAlign: 'right' }}>Rate</span>
        <span style={{ textAlign: 'right' }}>Net</span><span style={{ textAlign: 'right' }}>VAT</span><span style={{ textAlign: 'right' }}>Gross</span>
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: DETAIL_COLS, gap: 10, padding: '6px 0', fontSize: 12, borderBottom: i < lines.length - 1 ? '1px solid #f1f5f9' : 'none', alignItems: 'baseline' }}>
          <span style={{ fontWeight: 500, color: '#0f172a' }}>{l.service || '—'}</span>
          {/* pre-line so multi-line descriptions read as they were typed. */}
          <span style={{ color: '#475569', whiteSpace: 'pre-line' }}>{l.description || <span style={{ fontStyle: 'italic', color: '#cbd5e1' }}>No description</span>}</span>
          <span style={{ textAlign: 'right', fontFamily: 'monospace', color: '#64748b' }}>{fmtNum(l.qty ?? 1, 4) || '1'}</span>
          <span style={{ textAlign: 'right', fontFamily: 'monospace', color: '#64748b' }}>{fmt(l.rate != null ? l.rate : l.net)}</span>
          <span style={{ textAlign: 'right', fontFamily: 'monospace', color: '#64748b' }}>{fmt(l.net)}</span>
          <span style={{ textAlign: 'right', fontFamily: 'monospace', color: '#64748b' }}>{fmt(l.vat)}</span>
          <span style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#0f172a' }}>{fmt(l.gross)}</span>
        </div>
      ))}
    </div>
  );
}

// How many internal comments a bill carries, so the ones with something to
// read stand out in the list without having to open every tile.
function CommentTag({ count, compact }) {
  if (!count) return null;
  return (
    <span
      title={`${count} internal comment${count!==1?'s':''} — open the tile to read${count!==1?' them':''}`}
      style={{display:'inline-flex',alignItems:'center',gap:3,fontSize:10,fontWeight:600,color:'#7c3aed',background:'#f5f3ff',padding:'2px 6px',borderRadius:compact?4:6,flexShrink:0}}
    >
      <MessageSquare size={compact?10:11}/> {count}
    </span>
  );
}

// A bill raised without a figure. Deliberately not styled as an error — it's a
// normal step ("raise it now, price it later") that just isn't finished.
function UnpricedTag({ item, compact }) {
  if (isPriced(item) || item.status === 'pushed' || item.status === 'not_required') return null;
  return (
    <span
      title="No amount on this bill yet — put a figure on it before it can be approved or pushed"
      style={{fontSize:10,fontWeight:600,color:'#b45309',background:'#fffbeb',padding:compact?'2px 6px':'2px 8px',borderRadius:compact?4:6,flexShrink:0}}
    >Amount TBC</span>
  );
}

// The internal conversation about a bill. Athena-only: the QBO push reads the
// bill's lines and nothing else, so none of this can reach the client.
function BillComments({ comments, staffMap, meId, draft, onDraft, onAdd, onDelete, busy }) {
  return (
    <div style={{ borderTop: '1px solid #f1f5f9', background: '#fbfaff', padding: '10px 18px 12px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:10, fontWeight:700, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:8 }}>
        <MessageSquare size={11}/> Internal comments
        <span style={{ fontWeight:500, textTransform:'none', letterSpacing:0, fontSize:11, color:'#a5a3b8' }}>· stays in Athena, never sent to QuickBooks or the client</span>
      </div>
      {comments.length === 0 && (
        <p style={{ fontSize:12, color:'#cbd5e1', fontStyle:'italic', margin:'0 0 8px' }}>Nothing yet — add anything the approver should know about this bill.</p>
      )}
      {comments.length > 0 && (
        <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:10 }}>
          {comments.map((c)=>(
            <div key={c.id} style={{ background:'#fff', border:'1px solid #ede9fe', borderRadius:8, padding:'8px 10px' }}>
              <div style={{ display:'flex', alignItems:'baseline', gap:6, marginBottom:2 }}>
                <span style={{ fontSize:12, fontWeight:600, color:'#0f172a' }}>{staffMap[c.author_id]?.name || 'Unknown'}</span>
                <span style={{ fontSize:11, color:'#94a3b8' }}>{commentDate(c.created_at)}</span>
                {/* Only the author can remove their own comment (RLS enforces it too). */}
                {c.author_id === meId && (
                  <button onClick={()=>onDelete(c)} title="Delete this comment" style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', padding:2, display:'inline-flex' }}>
                    <Trash2 size={12} style={{ color:'#cbd5e1' }}/>
                  </button>
                )}
              </div>
              <div style={{ fontSize:12, color:'#475569', whiteSpace:'pre-line', lineHeight:1.5 }}>{c.body}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display:'flex', gap:8, alignItems:'flex-end' }}>
        <textarea
          value={draft}
          onChange={(e)=>onDraft(e.target.value)}
          onKeyDown={(e)=>{ if ((e.metaKey||e.ctrlKey) && e.key==='Enter') { e.preventDefault(); onAdd(); } }}
          rows={2}
          placeholder="Add a comment…"
          style={{ ...inputStyle, flex:1, resize:'vertical', minHeight:40, lineHeight:1.5, background:'#fff' }}
        />
        <button
          onClick={onAdd}
          disabled={busy || !draft.trim()}
          title="Ctrl/⌘ + Enter"
          style={{ ...btnPrimary, padding:'8px 12px', fontSize:12, opacity:(busy||!draft.trim())?0.4:1, cursor:(busy||!draft.trim())?'default':'pointer' }}
        >{busy ? 'Saving…' : 'Comment'}</button>
      </div>
    </div>
  );
}

// Number box that also does sums: type "100*10" and it becomes 1000 when
// you Tab or hit Enter. A plain number behaves exactly as before and keeps
// updating the rest of the line as you type; an expression is held locally
// until it's committed, so the line doesn't flicker through "100".
function CalcInput({ value, onChange, dp = 2, placeholder, style }) {
  const [draft, setDraft] = useState(null);
  const [bad, setBad] = useState(false);
  const text = draft !== null ? draft : (value ?? '');
  const handleChange = (e) => {
    const raw = e.target.value;
    setBad(false);
    if (isExpression(raw)) { setDraft(raw); return; }
    setDraft(null);
    onChange(raw);
  };
  const commit = () => {
    if (draft === null) return;
    const n = evalArithmetic(draft);
    // An unfinished sum stays put and goes red rather than silently
    // reverting — the typed figure isn't lost.
    if (n === null) { setBad(true); return; }
    setDraft(null); setBad(false);
    onChange(fmtNum(n, dp));
  };
  return (
    <input
      value={text}
      inputMode="decimal"
      placeholder={placeholder}
      onChange={handleChange}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      style={bad ? { ...style, borderColor: '#dc2626', background: '#fef2f2' } : style}
      title={bad ? "That isn't a sum this can work out" : undefined}
    />
  );
}

function ActionButtons({ item, onEdit, onDelete, onStatus, compact }) {
  const s = item.status;
  const sz = compact?12:14;
  const b = {background:'none',border:'none',cursor:'pointer',padding:compact?2:4,borderRadius:4,display:'inline-flex',alignItems:'center',transition:'all 0.12s'};
  // A £0.00 bill is a placeholder — raise it by all means, but it can't be
  // approved until someone puts a figure on it.
  const priced = isPriced(item);
  return (
    <div style={{display:'flex',gap:compact?3:5,alignItems:'center',flexShrink:0}}>
      {/* Approve — solid green so it's unmissable (was a faint grey tick). */}
      {s==='draft' && (
        <button onClick={()=>priced && onStatus(item,'approved')} disabled={!priced}
          title={priced?'Approve':"Needs an amount first — a £0.00 bill can't be approved or pushed"}
          style={{display:'inline-flex',alignItems:'center',gap:4,background:priced?'#059669':'#e2e8f0',color:priced?'#fff':'#94a3b8',border:'none',borderRadius:6,cursor:priced?'pointer':'not-allowed',padding:compact?'2px 7px':'5px 10px',fontSize:compact?10:12,fontWeight:600,fontFamily:"'Outfit', sans-serif"}}>
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
// Narrower gutters for the qty/rate/amount boxes — seven columns on one row.
const numInput = {...inputStyle,padding:'8px 7px',textAlign:'right'};
const modeBtn = {flex:1,textAlign:'left',padding:'10px 12px',borderRadius:10,border:'1px solid #e5e7eb',background:'#fff',cursor:'pointer',fontFamily:"'Outfit', sans-serif",color:'#0f172a'};
const navBtn = {padding:'2px 8px',borderRadius:6,border:'1px solid #e5e7eb',background:'#fff',cursor:'pointer',fontFamily:"'Outfit', sans-serif",fontSize:13,color:'#475569'};
// Client · Service · Type · QuickBooks customer · Send · Net · VAT · Gross.
// The customer column carries a full QBO customer name, so it needs room —
// truncating it to "GJ Cummins Plumbing a…" defeats the point of showing it.
const INVOICE_COLS = '1.3fr 0.9fr 0.5fr 1.5fr 1.9fr 0.8fr 0.7fr 0.85fr';
// Per-row Send/Draft toggle in the push-confirm list.
const sendToggleBtn = {padding:'3px 8px',fontSize:11,fontWeight:600,border:'none',background:'#fff',color:'#94a3b8',cursor:'pointer',fontFamily:"'Outfit', sans-serif",lineHeight:1.5};
const sendToggleSend = {background:'#059669',color:'#fff'};
const sendToggleDraft = {background:'#e2e8f0',color:'#334155'};
// Wider service column than the rest of the row needs: the product names run
// to "Business Accounts and Corporation Tax Combined" (sql/186), and a picker
// you can't read the end of is a picker you can choose wrongly from.
const LINE_COLS = '1.6fr 1.6fr 0.5fr 0.72fr 0.8fr 0.72fr 0.8fr 30px';
const DETAIL_COLS = '1.5fr 1.9fr 0.4fr 0.7fr 0.7fr 0.6fr 0.7fr';
const calcHint = { background: '#f1f5f9', borderRadius: 4, padding: '1px 4px', fontFamily: 'monospace', color: '#475569' };
// A fresh, empty editor line.
// descAuto: the description was pulled through from the QuickBooks product and
// hasn't been touched since, so changing the service may replace it. Stored and
// copied-in lines leave it unset — that text is somebody's own wording.
function blankLine() { return { service: '', description: '', qty: '', rate: '', net: '', vat: '', gross: '', vatManual: false, descAuto: false, touch: [] }; }

// Has someone actually put a figure on this bill? £0.00 is a legitimate way to
// raise one ("bill this, amount to be decided") — it just can't be approved or
// pushed until it's priced. Nothing about it is an error, so it's a state to
// show, not a validation failure.
function isPriced(item) { return Number(item?.net_amount) > 0; }

// Comment rows → { [billing_item_id]: [oldest … newest] }.
function groupComments(rows) {
  const out = {};
  (rows || []).forEach((c) => { (out[c.billing_item_id] = out[c.billing_item_id] || []).push(c); });
  return out;
}

// "2:14pm" today, "Tue 2:14pm" this week, "5 Aug" beyond that — a comment's
// age matters more than its exact timestamp.
function commentDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return time;
  if (days < 7) return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + (d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '');
}

// The stored lines for a bill, or a single line rebuilt from the legacy
// top-level fields for anything raised before multi-line bills existed.
function itemLines(item) {
  if (Array.isArray(item.lines) && item.lines.length) return item.lines;
  return [{
    service: item.service || '', description: item.description || '',
    qty: 1, rate: item.net_amount || 0,
    net: item.net_amount || 0, vat: item.vat_amount || 0, gross: item.gross_amount || 0,
  }];
}

// Qty/rate for the editor, falling back to "1 × the amount" for lines
// stored before the split existed (or where it no longer multiplies out).
function splitOf(qty, rate, net) {
  const n = Number(net) || 0;
  const q = Number(qty), r = Number(rate);
  const ok = Number.isFinite(q) && q > 0 && Number.isFinite(r) && Math.abs(q * r - n) < 0.005;
  return ok ? { qty: fmtNum(q, 4), rate: fmtNum(r, 4) } : { qty: n ? '1' : '', rate: n ? fmtNum(n, 4) : '' };
}

// Trim a number to at most `dp` decimals without leaving trailing zeros —
// 10 stays "10", 33.333333 becomes "33.3333".
function fmtNum(n, dp) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const s = v.toFixed(dp);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

// Qty × Rate = Amount. The two boxes you filled in most recently are held
// and the third is worked out, so: type an amount on a fresh line and you
// get 1 × that amount; then type a rate and the quantity falls out of it;
// type a quantity and a rate instead and the amount is calculated.
const CALC_FIELDS = ['qty', 'rate', 'net'];
function applyCalc(line, field, value) {
  const touch = [field, ...(line.touch || []).filter((f) => f !== field)].slice(0, 3);
  const next = { ...line, [field]: value, touch };
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

  // Which box gives way? Normally the one left untouched longest; on a line
  // that's only had a single figure entered, assume a quantity of one.
  let target = touch.length >= 2 ? CALC_FIELDS.find((f) => f !== touch[0] && f !== touch[1]) : null;
  if (!target) {
    if (field === 'qty') target = num(next.rate) != null ? 'net' : (num(next.net) != null ? 'rate' : null);
    else if (field === 'rate') target = num(next.net) != null ? 'qty' : 'net';
    else target = 'rate';
    if (field !== 'qty' && num(next.qty) == null) next.qty = value === '' ? '' : '1';
  }

  // A rate typed against a blank quantity means one of them — the same
  // "assume a quantity of one" rule the fallback above uses, applied to the
  // touch-driven branch too. Without it a line whose stored amount was £0.00
  // sits there ignoring every rate you type: splitOf only recovers a quantity
  // from a non-zero amount, so the £0.00 placeholders come back with the
  // quantity empty and nothing for the rate to multiply.
  if (target === 'net' && num(next.qty) == null && num(next.rate) != null) next.qty = '1';

  const qty = num(next.qty), rate = num(next.rate), net = num(next.net);
  if (value === '' && field !== 'qty') {
    // Clearing the amount or the rate clears what was derived from it,
    // rather than leaving a stale figure behind.
    if (target === 'net') next.net = '';
    if (target === 'rate') next.rate = '';
  } else if (target === 'net' && qty != null && rate != null) next.net = fmtNum(Math.round(qty * rate * 100) / 100, 2);
  else if (target === 'rate' && net != null && qty) next.rate = fmtNum(net / qty, 4);
  else if (target === 'qty' && net != null && rate) next.qty = fmtNum(net / rate, 4);
  return withVat(next);
}

// Keep VAT + gross in step with the line's amount. A hand-typed VAT figure
// is left alone; otherwise it's the standard rate.
function withVat(line) {
  const net = parseFloat(line.net);
  if (line.net === '' || !Number.isFinite(net)) return { ...line, vat: line.vatManual ? line.vat : '', gross: '' };
  const vat = line.vatManual ? (parseFloat(line.vat) || 0) : Math.round(net * VAT_RATE * 100) / 100;
  return { ...line, vat: line.vatManual ? line.vat : vat.toFixed(2), gross: (net + vat).toFixed(2) };
}

// Anything that isn't a plain decimal is treated as a sum to work out.
function isExpression(raw) {
  const s = String(raw).trim();
  return s !== '' && !/^-?\d*\.?\d*$/.test(s);
}

// Work out "100*10", "(120+30)*4", "=250/3". Hand-rolled rather than eval'd
// so a typo in a billing box can never run anything. Returns null if it
// isn't a sum this understands.
function evalArithmetic(input) {
  const s = String(input).trim().replace(/^=/, '').replace(/[£,\s]/g, '');
  if (!s || !/^[0-9+\-*/().]+$/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  const factor = () => {
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '-') { i++; const v = factor(); return v === null ? null : -v; }
    if (peek() === '(') {
      i++; const v = expr();
      if (peek() !== ')') return null;
      i++; return v;
    }
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    if (i === start) return null;
    const n = parseFloat(s.slice(start, i));
    return Number.isFinite(n) ? n : null;
  };
  const term = () => {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++]; const r = factor();
      if (v === null || r === null || (op === '/' && r === 0)) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++]; const r = term();
      if (v === null || r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const out = expr();
  return (i === s.length && out !== null && Number.isFinite(out)) ? out : null;
}
const ellip = { overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' };
const modeBtnActive = {borderColor:'#059669',background:'#f0fdf4',boxShadow:'0 0 0 1px #059669'};
const formLabel = {display:'block',fontSize:11,fontWeight:600,color:'#64748b',textTransform:'uppercase',marginBottom:4,fontFamily:"'Outfit', sans-serif"};
