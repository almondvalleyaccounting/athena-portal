import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2, ClipboardList, Copy, Download, Plus, X,
  ChevronDown, ChevronRight, MessageSquare, AlertTriangle, Send, CalendarDays, RotateCcw, Receipt,
  Flame, Paperclip, ChevronsDownUp, ChevronsUpDown, KeyRound,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../shell/AppShell';
import { commitAllocationDraft } from '../modules/work-planner/lib/allocationsQueries';
import ClientTypeAhead from '../modules/work-planner/components/ClientTypeAhead';
import { insertEntity } from '../modules/work-planner/lib/supabaseQueries';
import NewClientModal from '../components/NewClientModal';
import ServicePicker from '../modules/billing/ServicePicker';
import { fetchAdhocServices } from '../modules/billing/billingServices';
import { stageMeta } from '../modules/ch-codes/api';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };
const VAT_RATE = 0.20;

// A bill amount can be left blank or £0 — that's the "bill this, figure to be
// decided" case, and it's the honest way to raise a placeholder (the team used
// to type £0.01 to get past this). Only a negative or unreadable figure is
// wrong. The Billing module won't let a £0.00 bill be approved or pushed, so
// the amount still has to be settled before it reaches QuickBooks.
function billAmountOk(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return true;
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0;
}

/*
  Sophie's workspace — everything from her world on one page:
  - Tasks to key into BrightManager (auto-captured + manual), each with an
    optional deadline, a notes/responses thread, and one-click escalation
    (emails whoever needs to action it).
  - Reallocation proposals from the capacity planner (allocation_changes).
  - A live summary of in-flight onboardings.
  Sections collapse; tasks sort by deadline so the most urgent surface first.

  Completing a task moves it off the open list onto the Completed tab, where
  BM verification shows silently (awaiting check → confirmed) and a task can
  be reopened. Reopening sets reopened_at, which holds off BM auto-confirm
  until the task is completed again — otherwise a reopened task whose value
  BM already holds would vanish straight back to Completed on the next load.
*/

const FIELD_LABELS = { ch_auth_code: 'CH auth code', utr: 'UTR', vat_number: 'VAT number', paye_ref: 'PAYE ref' };

// Sections group by the module that generated the task (kind/source) so
// bulk-imported or manually-typed tasks don't get lost among the BM
// code-verification queue, which is what "To key into BrightManager" is for.
const TASK_GROUPS = [
  { key: 'manually_added', label: 'Manually Added', match: (t) => t.source === 'Added manually' || t.source === 'sophie_workplan_import' },
  { key: 'bm_keying', label: 'To key into BrightManager', match: (t) => t.kind === 'bm_code' },
  { key: 'bm_data_error', label: 'BM Data Errors', match: (t) => t.source === 'bm_data_error' },
  { key: 'person_dedup', label: 'Data quality — possible duplicate people', match: (t) => t.source === 'person_dedup' },
  { key: 'nlac_bm_mirror', label: 'Offboarding', match: (t) => t.source === 'nlac_bm_mirror' },
];
const GROUP_ORDER = [...TASK_GROUPS.map((g) => g.key), 'other'];
function groupKeyFor(t) { return (TASK_GROUPS.find((g) => g.match(t)) || { key: 'other' }).key; }
function groupLabelFor(key) { return (TASK_GROUPS.find((g) => g.key === key) || { label: 'Other' }).label; }

// Fixed live-aggregation sections rendered after the task groups.
const FIXED_SECTION_KEYS = ['chcodes', 'realloc', 'onboard'];
const COLLAPSE_LS_KEY = 'athena_admin_tasks_expanded';
// Last time this browser looked at the comments panel — used only to highlight
// what has arrived since. Read receipts proper live on the notifications table.
const COMMENTS_SEEN_LS_KEY = 'athena_admin_tasks_comments_seen';
// In-flight CH code chases shown on this list (pre-"entered" stages).
const CH_OPEN_STAGES = ['s1_offer', 's2_decision', 's3a_client', 's3b_us', 's4_code'];

function isoToday() { return new Date().toISOString().slice(0, 10); }
function fmtShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
/* Who put the task on the list. Manual and workplan tasks carry a staff
   created_by; module-generated ones do not, and for those the section heading
   already names the generator — so an empty label beats "system". */
function addedByLabel(t, staffMap) {
  if (t.created_by) return (staffMap && staffMap[t.created_by]) || 'staff';
  if (t.source === 'sophie_workplan_import') return 'Workplan import';
  return null;
}
function fmtNoteTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function AdminTasksPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [tasks, setTasks] = useState(null);
  const [completed, setCompleted] = useState(null);
  const [view, setView] = useState('open');
  const [notesByTask, setNotesByTask] = useState({});
  const [drafts, setDrafts] = useState([]);
  const [onboardings, setOnboardings] = useState([]);
  const [entities, setEntities] = useState({});
  const [staffMap, setStaffMap] = useState({});
  const [staffList, setStaffList] = useState([]);
  const [confirmedNow, setConfirmedNow] = useState(0);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newClient, setNewClient] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [newUrgent, setNewUrgent] = useState(false);
  const [newFiles, setNewFiles] = useState([]);
  const [savingTask, setSavingTask] = useState(false);
  const [newBillable, setNewBillable] = useState(false);
  const [newBillAmount, setNewBillAmount] = useState('');
  const [allEntities, setAllEntities] = useState([]);
  const [newClientModal, setNewClientModal] = useState({ open: false, initialName: '', resolve: null });
  const [copied, setCopied] = useState(null);
  const [chCodes, setChCodes] = useState([]);
  const [docsByTask, setDocsByTask] = useState({});
  const [billingById, setBillingById] = useState({}); // billing_items status for pipeline stages
  const [fees, setFees] = useState([]); // standard_fees price book (service → standard net)
  const [serviceOptions, setServiceOptions] = useState([]); // the Billing module's own service options
  const [newService, setNewService] = useState('');
  const canPipeline = !!profile?.can_manage_task_pipeline;

  // A task's service has to be one the Billing module offers, because that's
  // where its bill lands and what resolves to a QuickBooks product on the
  // push. So this is the same picker reading the same list — not a parallel
  // vocabulary. (It used to read the standard_fees price book, which is empty
  // and fee-gated on top, so the dropdown was empty for everybody.)
  const isBillableService = (id) => !!id && serviceOptions.some((o) => o.id === id);
  const feeFor = (serviceId) => { const f = fees.find((x) => x.service_id === serviceId); return f ? Number(f.standard_net) : null; };
  const [clientFilter, setClientFilter] = useState('');
  // Report tab data — completions + creations over the last 14 days,
  // loaded lazily the first time the Report view opens.
  const [reportRows, setReportRows] = useState(null);
  const [reportCreated, setReportCreated] = useState(null);

  const [openNotes, setOpenNotes] = useState(() => new Set());
  const [showAllComments, setShowAllComments] = useState(false);
  // Read ONCE at mount. The effect below moves the stored watermark forward a
  // few seconds later, so re-reading it would clear the highlight out from
  // under the comments you are still reading.
  const [seenWatermark] = useState(() => {
    try { return localStorage.getItem(COMMENTS_SEEN_LS_KEY); } catch { return null; }
  });
  const [escalateTask, setEscalateTask] = useState(null);
  const [billTask, setBillTask] = useState(null); // task whose bill is being raised
  const [completeTask, setCompleteTask] = useState(null);
  // Sections default COLLAPSED — we persist which ones are expanded, so a
  // fresh load always opens with everything folded to the counts.
  const [expandedSet, setExpandedSet] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_LS_KEY) || '[]')); } catch { return new Set(); }
  });
  const persistExpanded = (n) => {
    setExpandedSet(n);
    try { localStorage.setItem(COLLAPSE_LS_KEY, JSON.stringify([...n])); } catch { /* storage unavailable */ }
  };
  const toggleCollapse = (key) => {
    const n = new Set(expandedSet);
    n.has(key) ? n.delete(key) : n.add(key);
    persistExpanded(n);
  };

  const load = useCallback(async () => {
    try {
      const { data: confirmed } = await supabase.rpc('admin_tasks_confirm_from_bm');
      if (confirmed > 0) setConfirmedNow(confirmed);

      const [{ data: t, error: e1 }, { data: ct }, { data: d }, { data: st }, { data: obs }, { data: ents }, { data: ch }, { data: sf }, svc] = await Promise.all([
        supabase.from('admin_tasks')
          .select('*, entity:entities(id, name)')
          .is('done_at', null).is('confirmed_at', null).is('dismissed_at', null)
          .order('created_at', { ascending: false }),
        supabase.from('admin_tasks')
          .select('*, entity:entities(id, name)')
          .is('dismissed_at', null)
          .or('done_at.not.is.null,confirmed_at.not.is.null')
          .order('done_at', { ascending: false, nullsFirst: false })
          .limit(150),
        supabase.from('allocation_changes').select('*').eq('status', 'draft'),
        supabase.from('staff_profiles').select('id, name, email, is_active'),
        supabase.from('onboardings')
          .select('id, status, target_date, entity:entities(id, name), owner_id')
          .in('status', ['active', 'issues']),
        supabase.from('entities').select('id, name').order('name'),
        supabase.from('ch_code_requests')
          .select(`id, stage, emails_sent, updated_at,
            person:people(id, name),
            entity:entities!ch_code_requests_entity_id_fkey(id, name)`)
          .in('stage', CH_OPEN_STAGES)
          .order('updated_at', { ascending: true }),
        supabase.from('standard_fees').select('task_name, service_id, standard_net'),
        fetchAdhocServices(),
      ]);
      if (e1) throw e1;
      setTasks(t || []);
      setCompleted(ct || []);
      setDrafts(d || []);

      // Billing-item status for tasks in the billing pipeline (Bill & Hold vs
      // Billed is derived from whether the linked invoice has been pushed).
      const billIds = [...new Set([...(t || []), ...(ct || [])].map((x) => x.billing_item_id).filter(Boolean))];
      if (billIds.length) {
        const { data: bills } = await supabase.from('billing_items')
          .select('id, status, qbo_invoice_id, net_amount, gross_amount').in('id', billIds);
        setBillingById(Object.fromEntries((bills || []).map((b) => [b.id, b])));
      } else {
        setBillingById({});
      }
      setAllEntities(ents || []);
      setChCodes(ch || []);
      setFees(sf || []);
      setServiceOptions(svc || []);
      const st2 = (st || []);
      setStaffMap(Object.fromEntries(st2.map((s) => [s.id, s.name])));
      setStaffList(st2.filter((s) => s.is_active !== false && s.email).sort((a, b) => (a.name || '').localeCompare(b.name || '')));

      // Notes for open AND completed tasks. Completed used to be excluded, which
      // meant a note written on a task somebody then ticked off became
      // unreachable from this page — the Completed row had no thread and the
      // note was never fetched. Sophie's "we are already agents for Stuart
      // Angus on HMRC" sat in that hole.
      const allTaskIds = [...(t || []), ...(ct || [])].map((x) => x.id);
      if (allTaskIds.length) {
        const { data: notes } = await supabase.from('admin_task_notes')
          .select('*').in('task_id', allTaskIds).order('created_at', { ascending: true });
        const grouped = {};
        for (const n of notes || []) (grouped[n.task_id] ||= []).push(n);
        setNotesByTask(grouped);
      } else {
        setNotesByTask({});
      }

      // Attachments (open + completed)
      if (allTaskIds.length) {
        const { data: docs } = await supabase.from('admin_task_documents')
          .select('*').in('task_id', allTaskIds).order('created_at', { ascending: true });
        const grouped = {};
        for (const doc of docs || []) (grouped[doc.task_id] ||= []).push(doc);
        setDocsByTask(grouped);
      } else {
        setDocsByTask({});
      }

      // Entity names for reallocation drafts
      const entIds = [...new Set((d || []).map((x) => x.entity_id).filter(Boolean))];
      if (entIds.length) {
        const { data: ents } = await supabase.from('entities').select('id, name').in('id', entIds);
        setEntities(Object.fromEntries((ents || []).map((e) => [e.id, e.name])));
      }

      // Onboarding progress from steps
      const obIds = (obs || []).map((o) => o.id);
      let stepRows = [];
      if (obIds.length) {
        const { data: steps } = await supabase.from('onboarding_steps')
          .select('onboarding_id, name, completed_at, group_sort, sort')
          .in('onboarding_id', obIds);
        stepRows = steps || [];
      }
      const byOb = {};
      for (const s of stepRows) (byOb[s.onboarding_id] ||= []).push(s);
      const enriched = (obs || []).map((o) => {
        const steps = (byOb[o.id] || []).slice().sort((a, b) => (a.group_sort - b.group_sort) || (a.sort - b.sort));
        const done = steps.filter((s) => s.completed_at).length;
        const next = steps.find((s) => !s.completed_at);
        return { ...o, total: steps.length, done, nextStep: next?.name || null };
      }).sort((a, b) => (a.status === 'issues' ? -1 : 1) - (b.status === 'issues' ? -1 : 1)
        || (a.target_date || '9999').localeCompare(b.target_date || '9999'));
      setOnboardings(enriched);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load report data the first time the Report tab opens.
  useEffect(() => {
    if (view !== 'report' || reportRows !== null) return;
    (async () => {
      try {
        const since = new Date();
        since.setHours(0, 0, 0, 0);
        since.setDate(since.getDate() - 13);
        const sinceIso = since.toISOString();
        const [{ data: doneRows, error: e1 }, { data: createdRows, error: e2 }] = await Promise.all([
          supabase.from('admin_tasks')
            .select('done_at, done_by, done_minutes, source, kind, entity_id, entity:entities(id, name)')
            .gte('done_at', sinceIso)
            .order('done_at', { ascending: true }),
          supabase.from('admin_tasks')
            .select('id, created_at, entity_id')
            .gte('created_at', sinceIso),
        ]);
        if (e1) throw e1;
        if (e2) throw e2;
        setReportRows(doneRows || []);
        setReportCreated(createdRows || []);
      } catch (e) { setError(e.message); }
    })();
  }, [view, reportRows]);

  async function complete(task, { doneBy, minutes } = {}) {
    const now = new Date().toISOString();
    // Field-less tasks have nothing BM can verify, so they confirm immediately.
    const patch = {
      done_at: now,
      done_by: doneBy || profile?.id || null,
      done_minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null,
      ...(task.field ? {} : { confirmed_at: now }),
    };
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    setCompleted((prev) => [{ ...task, ...patch }, ...(prev || [])]);
    const { error: err } = await supabase.from('admin_tasks').update(patch).eq('id', task.id);
    if (err) { setError(err.message); load(); }
  }

  async function reopen(task) {
    const patch = { done_at: null, confirmed_at: null, reopened_at: new Date().toISOString() };
    setCompleted((prev) => (prev || []).filter((t) => t.id !== task.id));
    setTasks((prev) => [{ ...task, ...patch }, ...(prev || [])]);
    const { error: err } = await supabase.from('admin_tasks').update(patch).eq('id', task.id);
    if (err) { setError(err.message); load(); }
  }

  async function dismiss(task) {
    if (!window.confirm(`Remove "${task.title}" from the list?`)) return;
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    const { error: err } = await supabase.from('admin_tasks')
      .update({ dismissed_at: new Date().toISOString() }).eq('id', task.id);
    if (err) { setError(err.message); load(); }
  }

  async function setDeadline(task, date) {
    const val = date || null;
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, deadline: val } : t)));
    const { error: err } = await supabase.from('admin_tasks').update({ deadline: val }).eq('id', task.id);
    if (err) { setError(err.message); load(); }
  }

  async function completeRealloc(draft) {
    setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
    try {
      await commitAllocationDraft(draft.id, profile?.id);
    } catch (e) {
      setError(e.message);
      load();
    }
  }

  async function uploadTaskFiles(taskId, files) {
    for (const file of files) {
      const safe = (file.name || 'file').replace(/[^\w.\-]+/g, '_');
      const path = `admin-tasks/${taskId}/${crypto.randomUUID()}-${safe}`;
      const { error: upErr } = await supabase.storage.from('client-documents')
        .upload(path, file, { contentType: file.type || undefined });
      if (upErr) { setError(`Upload failed for ${file.name}: ${upErr.message}`); continue; }
      const { error: rowErr } = await supabase.from('admin_task_documents').insert({
        task_id: taskId, storage_path: path, original_name: file.name,
        mime_type: file.type || null, size_bytes: file.size || null, uploaded_by: profile?.id || null,
      });
      if (rowErr) setError(rowErr.message);
    }
  }

  async function refreshTaskDocs(taskId) {
    const { data } = await supabase.from('admin_task_documents')
      .select('*').eq('task_id', taskId).order('created_at', { ascending: true });
    setDocsByTask((prev) => ({ ...prev, [taskId]: data || [] }));
  }

  async function attachToTask(taskId, fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    await uploadTaskFiles(taskId, files);
    await refreshTaskDocs(taskId);
  }

  async function openDoc(doc) {
    const { data, error: err } = await supabase.storage.from('client-documents')
      .createSignedUrl(doc.storage_path, 3600);
    if (err) { setError(err.message); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  async function deleteDoc(doc) {
    if (!window.confirm(`Remove attachment "${doc.original_name}"?`)) return;
    const { error: err } = await supabase.from('admin_task_documents').delete().eq('id', doc.id);
    if (err) { setError(err.message); return; }
    await supabase.storage.from('client-documents').remove([doc.storage_path]);
    setDocsByTask((prev) => ({ ...prev, [doc.task_id]: (prev[doc.task_id] || []).filter((d) => d.id !== doc.id) }));
  }

  async function toggleUrgent(task) {
    const urgent = !task.urgent;
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, urgent } : t)));
    const { error: err } = await supabase.from('admin_tasks').update({ urgent }).eq('id', task.id);
    if (err) { setError(err.message); load(); }
  }

  // A task can be raised for a client we haven't got on file yet — typing the
  // name in the client picker offers "+ Add", which opens the shared
  // NewClientModal here and resolves with the new entity so the picker selects
  // it. Without this the picker's add link had no handler and did nothing.
  const openNewClientModal = useCallback((name) => (
    new Promise((resolve) => setNewClientModal({ open: true, initialName: name, resolve }))
  ), []);

  const handleNewClientSave = useCallback(async (fields) => {
    const data = await insertEntity(fields); // throws → the modal shows the error and stays open
    setAllEntities((prev) => [...prev, { id: data.id, name: data.name }]
      .sort((a, b) => a.name.localeCompare(b.name)));
    setEntities((prev) => ({ ...prev, [data.id]: data.name }));
    setNewClientModal((m) => { if (m.resolve) m.resolve(data); return { open: false, initialName: '', resolve: null }; });
    return data;
  }, []);

  const handleNewClientClose = useCallback(() => {
    // Resolve with null so the picker doesn't sit waiting on a cancelled modal.
    setNewClientModal((m) => { if (m.resolve) m.resolve(null); return { open: false, initialName: '', resolve: null }; });
  }, []);

  async function addManual(asDraft = false) {
    if (!newTitle.trim() || savingTask) return;
    if (newBillable && (!newClient || !billAmountOk(newBillAmount))) return;
    setSavingTask(true);
    try {
      // Draft → held off the live list. Otherwise a billable task starts in
      // Bill & Hold (a bill needs raising); everything else is live (To Do).
      const stage = asDraft ? 'draft' : (newBillable ? 'bill_hold' : 'todo');
      const { data: inserted, error: err } = await supabase.from('admin_tasks').insert({
        kind: 'manual', title: newTitle.trim(), detail: newNotes.trim() || null,
        entity_id: newClient || null, deadline: newDate || null, urgent: newUrgent,
        source: 'Added manually', created_by: profile?.id || null,
        billable: newBillable, stage, service_id: newService || null,
      }).select('id').single();
      if (err) throw err;

      if (newFiles.length) await uploadTaskFiles(inserted.id, newFiles);

      // 'Admin' used to stand in when no service was picked. It's no longer a
      // billable code, so a billable task needs a real service — the task
      // itself still saves, only the bill is held back.
      if (newBillable && !newService) {
        setError('Pick a service for this task before billing it — Admin is no longer a billable code.');
      } else if (newBillable) {
        // Standard fee from the price book if the amount was left blank — but a
        // typed 0 means 0 (it used to fall through to the standard fee, which
        // silently priced a bill nobody had priced).
        const typed = String(newBillAmount ?? '').trim();
        const net = typed === '' ? (feeFor(newService) || 0) : (parseFloat(typed) || 0);
        const vat = Math.round(net * VAT_RATE * 100) / 100;
        const gross = Math.round((net + vat) * 100) / 100;
        const { data: bill, error: billErr } = await supabase.from('billing_items').insert({
          entity_id: newClient, service: newService, description: newTitle.trim(),
          net_amount: net, vat_amount: vat, gross_amount: gross,
          status: 'draft', created_by: profile?.id || null,
        }).select('id').single();
        if (billErr) { setError(billErr.message); }
        else {
          await supabase.from('admin_tasks').update({ billing_item_id: bill.id }).eq('id', inserted.id);
        }
      }

      setNewTitle(''); setNewClient(''); setNewDate(''); setNewNotes(''); setNewUrgent(false); setNewFiles([]);
      setNewBillable(false); setNewBillAmount(''); setNewService('');
      setAdding(false); setView('open'); load();
    } catch (e) { setError(e.message); }
    setSavingTask(false);
  }

  // Add a bill to an existing task → creates a draft billing_items row (into
  // the Billing Module for accept/send) and moves the task to Bill & Hold.
  // The service and the amount are asked for in the modal, where the answer can
  // be given on the spot. This used to refuse the click outright when the task
  // had no service, setting an error banner at the top of the page — out of
  // sight of the row that was clicked, so the button looked dead. No task has
  // ever carried a service, so that was every click.
  async function addBillToTask(t, { serviceId, net, hold }) {
    if (!t.entity_id) { setError('Add a client to the task before billing it.'); return; }
    if (!isBillableService(serviceId)) { setError('Pick a service Billing offers before raising the bill.'); return; }
    const vat = Math.round(net * VAT_RATE * 100) / 100;
    const gross = Math.round((net + vat) * 100) / 100;
    const { data: bill, error: be } = await supabase.from('billing_items').insert({
      entity_id: t.entity_id, service: serviceId, description: t.title,
      net_amount: net, vat_amount: vat, gross_amount: gross,
      status: 'draft', created_by: profile?.id || null,
    }).select('id').single();
    if (be) { setError(be.message); return; }
    // The service goes onto the task too — it is what the work was billed as,
    // and the task is where the next person looks for that.
    //
    // Holding moves the task to Bill & Hold, off the live list until the bill
    // is settled. Not holding leaves the stage alone, so a task that is still
    // work to do stays on To Do with its bill attached — billing something is
    // not the same as having finished it.
    const patch = { billable: true, billing_item_id: bill.id, service_id: serviceId };
    if (hold) patch.stage = 'bill_hold';
    const { error: ue } = await supabase.from('admin_tasks')
      .update(patch).eq('id', t.id);
    if (ue) { setError(ue.message); return; }
    load();
  }

  // Release Billed → To Do (RPC enforces can_manage_task_pipeline).
  async function releaseTask(t) {
    const { error: e } = await supabase.rpc('release_admin_task', { p_task_id: t.id });
    if (e) { setError(e.message); return; }
    load();
  }

  // Publish a Draft: onto the live list, or into Bill & Hold if it carries a bill.
  async function publishDraft(t) {
    const { error: e } = await supabase.from('admin_tasks')
      .update({ stage: t.billing_item_id ? 'bill_hold' : 'todo' }).eq('id', t.id);
    if (e) { setError(e.message); return; }
    load();
  }

  // Manager-set pipeline step from the row dropdown (change a task's step).
  async function setTaskStage(t, stage) {
    if (stage === (t.stage || 'todo')) return;
    const { error: e } = await supabase.from('admin_tasks').update({ stage }).eq('id', t.id);
    if (e) { setError(e.message); return; }
    load();
  }

  async function addNote(taskId, body) {
    const text = (body || '').trim();
    if (!text) return;
    const { data, error: err } = await supabase.from('admin_task_notes')
      .insert({ task_id: taskId, author_id: profile?.id || null, kind: 'note', body: text })
      .select('*').single();
    if (err) { setError(err.message); return; }
    setNotesByTask((prev) => ({ ...prev, [taskId]: [...(prev[taskId] || []), data] }));
  }

  async function submitEscalation(task, toStaffId, note) {
    const { data, error: err } = await supabase.functions.invoke('admin-task-escalate', {
      body: { task_id: task.id, to_staff_id: toStaffId, note },
    });
    if (err || !data?.success) { setError((err?.message) || data?.error || 'Escalation failed'); return false; }
    // Bell notification alongside the email the edge function sends.
    supabase.rpc('notify_staff', {
      p_recipient: toStaffId, p_kind: 'admin_task_escalated',
      p_title: `Admin task escalated to you: ${task.title}`, p_link: '/planner/tasks',
    }).then(({ error: nErr }) => { if (nErr) console.error('[AdminTasks] notify', nErr); });
    setTasks((prev) => prev.map((t) => (t.id === task.id
      ? { ...t, escalated_to: toStaffId, escalated_at: new Date().toISOString(), escalation_note: note || null } : t)));
    // Pull the escalation note the function wrote onto the thread.
    const { data: notes } = await supabase.from('admin_task_notes')
      .select('*').eq('task_id', task.id).order('created_at', { ascending: true });
    setNotesByTask((prev) => ({ ...prev, [task.id]: notes || [] }));
    setOpenNotes((prev) => new Set(prev).add(task.id));
    return true;
  }

  function copyValue(task) {
    navigator.clipboard?.writeText(task.value || '');
    setCopied(task.id);
    setTimeout(() => setCopied(null), 1500);
  }

  function toggleNotes(taskId) {
    setOpenNotes((prev) => {
      const n = new Set(prev);
      n.has(taskId) ? n.delete(taskId) : n.add(taskId);
      return n;
    });
  }

  function exportCsv() {
    const rows = (open).map((t) => ({
      Client: t.entity?.name || '', Task: t.title, Notes: t.detail || '',
      Urgent: t.urgent ? 'yes' : '', Field: FIELD_LABELS[t.field] || t.field || '',
      Value: t.value || '', Deadline: t.deadline || '', Source: t.source || '',
      Added: new Date(t.created_at).toLocaleDateString('en-GB'),
      'Added by': addedByLabel(t, staffMap) || '',
      Escalated: t.escalated_to ? (staffMap[t.escalated_to] || 'yes') : '',
      Status: 'open',
    }));
    const headers = ['Client', 'Task', 'Notes', 'Urgent', 'Field', 'Value', 'Deadline', 'Source', 'Added', 'Added by', 'Escalated', 'Status'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = `admin-tasks-${isoToday()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  const open = useMemo(() => {
    let list = (tasks || []).filter((t) => !t.done_at && !t.confirmed_at);
    if (clientFilter) list = list.filter((t) => t.entity_id === clientFilter);
    return list.sort((a, b) => {
      if (!!a.urgent !== !!b.urgent) return a.urgent ? -1 : 1; // urgent first
      const ad = a.deadline || '9999-12-31', bd = b.deadline || '9999-12-31';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  }, [tasks, clientFilter]);

  const completedFiltered = useMemo(() => {
    const list = completed || [];
    return clientFilter ? list.filter((t) => t.entity_id === clientFilter) : list;
  }, [completed, clientFilter]);
  const reportCompletions = useMemo(() => {
    const list = reportRows || [];
    return clientFilter ? list.filter((t) => t.entity_id === clientFilter) : list;
  }, [reportRows, clientFilter]);
  const reportCreatedFiltered = useMemo(() => {
    const list = reportCreated || [];
    return clientFilter ? list.filter((t) => t.entity_id === clientFilter) : list;
  }, [reportCreated, clientFilter]);
  const filteredDrafts = useMemo(
    () => (clientFilter ? drafts.filter((d) => d.entity_id === clientFilter) : drafts),
    [drafts, clientFilter]
  );
  const filteredOnboardings = useMemo(
    () => (clientFilter ? onboardings.filter((o) => o.entity?.id === clientFilter) : onboardings),
    [onboardings, clientFilter]
  );
  // One entry per PERSON (a person needs one code across all their companies),
  // matching how the CH codes pipeline counts its tiles.
  const filteredChCodes = useMemo(() => {
    const source = clientFilter ? chCodes.filter((r) => r.entity?.id === clientFilter) : chCodes;
    const byPerson = new Map();
    for (const r of source) {
      const key = r.person?.id || r.id;
      if (!byPerson.has(key)) byPerson.set(key, { ...r, entities: [] });
      const g = byPerson.get(key);
      if (r.entity?.name && !g.entities.includes(r.entity.name)) g.entities.push(r.entity.name);
    }
    return [...byPerson.values()];
  }, [chCodes, clientFilter]);

  // ── Comments, surfaced ──────────────────────────────────────────────────
  // The thread on a task is three clicks from a fresh load: expand the
  // section, find the row, click the speech bubble. So a colleague's comment
  // was invisible in practice — Sophie wrote five and nobody read one. The
  // newest comments now sit on the page itself, above the collapsed sections,
  // with the client and who wrote it. Own comments included (they're the
  // thread), but the count chip only counts other people's.
  const recentComments = useMemo(() => {
    // `completed` is null until the first load lands — the page uses null to
    // mean "not fetched", the way `open` guards with (tasks || []). Spreading
    // it raw threw on first render, which blanked the whole page.
    const byId = new Map([...open, ...(completed || [])].map((t) => [t.id, t]));
    const rows = [];
    for (const [taskId, notes] of Object.entries(notesByTask)) {
      const task = byId.get(taskId);
      if (!task) continue;
      if (clientFilter && task.entity_id !== clientFilter) continue;
      for (const n of notes) rows.push({ ...n, task });
    }
    return rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }, [notesByTask, open, completed, clientFilter]);

  // "Unread" without a read-receipts table: comments by someone else since the
  // last time this browser had the page open. It resets per browser, which is
  // honest about what it knows — the notification bell (sql/265) is the part
  // that follows you across devices.
  const commentsSinceLastVisit = useMemo(
    () => recentComments.filter((n) => n.author_id && n.author_id !== profile?.id
      && (!seenWatermark || (n.created_at || '') > seenWatermark)),
    [recentComments, profile?.id, seenWatermark]
  );

  // Stamp the visit once the comments have actually loaded and been rendered.
  useEffect(() => {
    if (!recentComments.length) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(COMMENTS_SEEN_LS_KEY, new Date().toISOString()); } catch { /* storage unavailable */ }
    }, 4000);
    return () => clearTimeout(t);
  }, [recentComments.length]);

  const stats = useMemo(() => {
    const today = isoToday();
    return {
      open: open.length,
      urgent: open.filter((t) => t.urgent).length,
      overdue: open.filter((t) => t.deadline && t.deadline < today).length,
      escalated: open.filter((t) => t.escalated_to).length,
      realloc: filteredDrafts.length,
      onboarding: filteredOnboardings.length,
      chcodes: filteredChCodes.length,
    };
  }, [open, filteredDrafts, filteredOnboardings, filteredChCodes]);

  // ── Manually generated vs system generated ──
  // Manual = things we initiate in Athena (added-manually + uploaded workplan);
  // these flow through the billing pipeline (Draft → Bill & Hold → Billed →
  // To Do). System = data issues Athena's rules raise (BM keying, data errors,
  // duplicate people).
  const MANUAL_SOURCES = ['Added manually', 'sophie_workplan_import'];
  const isManual = (t) => MANUAL_SOURCES.includes(t.source);
  const billPushed = useCallback((t) => {
    const b = billingById[t.billing_item_id];
    return !!b && (!!b.qbo_invoice_id || ['pushed', 'sent', 'paid'].includes(b.status));
  }, [billingById]);
  const stageOf = (t) => t.stage || 'todo';

  const manualOpen = useMemo(() => open.filter(isManual), [open]);
  const draftOpen = useMemo(() => manualOpen.filter((t) => stageOf(t) === 'draft'), [manualOpen]);
  const billHoldOpen = useMemo(() => manualOpen.filter((t) => stageOf(t) === 'bill_hold' && !billPushed(t)), [manualOpen, billPushed]);
  const billedOpen = useMemo(() => manualOpen.filter((t) => stageOf(t) === 'billed' || (stageOf(t) === 'bill_hold' && billPushed(t))), [manualOpen, billPushed]);
  const todoOpen = useMemo(() => manualOpen.filter((t) => stageOf(t) === 'todo'), [manualOpen]);

  // System-generated data-issue tasks grouped by source. Offboarding (we
  // triggered it by marking NLAC) shows under Manually generated.
  const SYSTEM_KEYS = ['bm_keying', 'bm_data_error', 'person_dedup', 'other'];
  const systemGroups = useMemo(() => {
    const buckets = {};
    for (const t of open) {
      if (isManual(t) || t.source === 'nlac_bm_mirror') continue;
      (buckets[groupKeyFor(t)] ||= []).push(t);
    }
    return buckets;
  }, [open]);
  const offboardingOpen = useMemo(() => open.filter((t) => t.source === 'nlac_bm_mirror'), [open]);
  const visibleSystemKeys = SYSTEM_KEYS.filter((k) => (systemGroups[k]?.length || 0) > 0);

  const groupedCompleted = useMemo(() => {
    const buckets = {};
    for (const t of completedFiltered) (buckets[groupKeyFor(t)] ||= []).push(t);
    return buckets;
  }, [completedFiltered]);
  const completedGroupKeys = useMemo(
    () => GROUP_ORDER.filter((k) => (groupedCompleted[k]?.length || 0) > 0),
    [groupedCompleted]
  );

  // Where admin time goes: minutes recorded on completed tasks, by task type
  // and by client. Groundwork for feeding admin fees charged to clients.
  const timeSummary = useMemo(() => {
    const timed = completedFiltered.filter((t) => t.done_minutes > 0);
    if (!timed.length) return null;
    const total = timed.reduce((s, t) => s + t.done_minutes, 0);
    const agg = (keyFn, labelFn) => {
      const m = new Map();
      for (const t of timed) {
        const k = keyFn(t);
        if (!k) continue;
        m.set(k, (m.get(k) || 0) + t.done_minutes);
      }
      return [...m.entries()].map(([k, v]) => ({ label: labelFn ? labelFn(k) : k, minutes: v }))
        .sort((a, b) => b.minutes - a.minutes);
    };
    return {
      total, count: timed.length,
      byType: agg((t) => groupKeyFor(t), (k) => groupLabelFor(k)),
      byClient: agg((t) => t.entity?.name).slice(0, 8),
    };
  }, [completedFiltered]);

  // Collapse-all treats every section (both groups + fixed) as one set.
  const allSectionKeys = ['draft', 'bill_hold', 'billed', 'todo', 'realloc', 'onboard',
    'offboarding', 'bm_keying', 'bm_data_error', 'person_dedup', 'other', 'chcodes'];
  const allCollapsed = !allSectionKeys.some((k) => expandedSet.has(k));
  const toggleAllCollapsed = () => persistExpanded(allCollapsed ? new Set(allSectionKeys) : new Set());

  // Shared open-task row — `extra` adds stage actions (add bill / release).
  const taskRow = (t, extra = {}) => (
    <TaskRow
      key={t.id} t={t}
      notes={notesByTask[t.id] || []} notesOpen={openNotes.has(t.id)}
      docs={docsByTask[t.id] || []}
      staffMap={staffMap} copied={copied === t.id}
      onComplete={() => setCompleteTask(t)}
      onCopy={() => copyValue(t)}
      onDismiss={() => dismiss(t)}
      onDeadline={(d) => setDeadline(t, d)}
      onToggleNotes={() => toggleNotes(t.id)}
      onAddNote={(body) => addNote(t.id, body)}
      onEscalate={() => setEscalateTask(t)}
      onToggleUrgent={() => toggleUrgent(t)}
      onAttach={(files) => attachToTask(t.id, files)}
      onOpenDoc={openDoc}
      onDeleteDoc={deleteDoc}
      onOpenClient={t.entity?.id ? () => navigate(`/clients/${t.entity.id}`) : null}
      onOpen={() => navigate(`/planner/tasks/${t.id}`)}
      onReviewBill={t.billing_item_id ? () => navigate(`/billing?highlight=${t.billing_item_id}`) : null}
      onSetStage={(stage) => setTaskStage(t, stage)}
      {...extra}
    />
  );

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px 32px 48px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <ClipboardList size={20} color="#0e7fe0" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Admin task list</h1>

        {/* Stat chips share the header row — width is better spent here than stacked below */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 20 }}>
          <Chip label="Open" value={stats.open} />
          <Chip label="Urgent" value={stats.urgent} tone={stats.urgent ? 'red' : 'muted'} />
          <Chip label="Overdue" value={stats.overdue} tone={stats.overdue ? 'red' : 'muted'} />
          <Chip label="Escalated" value={stats.escalated} tone={stats.escalated ? 'amber' : 'muted'} />
          <Chip label="Reallocations" value={stats.realloc} tone={stats.realloc ? 'blue' : 'muted'} />
          <Chip label="Onboarding" value={stats.onboarding} tone={stats.onboarding ? 'blue' : 'muted'} />
          <Chip label="CH codes" value={stats.chcodes} tone={stats.chcodes ? 'blue' : 'muted'} />
          <Chip label="New comments" value={commentsSinceLastVisit.length}
            tone={commentsSinceLastVisit.length ? 'blue' : 'muted'} />
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexShrink: 0 }}>
          <button onClick={exportCsv} disabled={!open.length} style={btn('ghost')}><Download size={13} /> Export CSV</button>
          <button onClick={() => setAdding((v) => !v)} style={btn('primary')}><Plus size={13} /> Add task</button>
        </div>
      </div>

      {/* Filter + collapse toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>Filter by client</span>
        <ClientTypeAhead entityList={allEntities} value={clientFilter} onChange={setClientFilter} size="small" />
        {clientFilter && (
          <button onClick={() => setClientFilter('')} style={{ ...btn('ghost'), padding: '4px 9px', fontSize: 11.5 }}>
            <X size={11} /> Clear
          </button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <TabBtn active={view === 'open'} onClick={() => setView('open')}>Open</TabBtn>
          <TabBtn active={view === 'completed'} onClick={() => setView('completed')}>Completed</TabBtn>
          {profile?.can_view_admin_report && (
            <TabBtn active={view === 'report'} onClick={() => setView('report')}>Report</TabBtn>
          )}
          <button onClick={toggleAllCollapsed} style={btn('ghost')}>
            {allCollapsed ? <><ChevronsUpDown size={13} /> Expand all</> : <><ChevronsDownUp size={13} /> Collapse all</>}
          </button>
        </div>
      </div>

      {confirmedNow > 0 && (
        <div style={{ ...card, borderColor: '#bbf7d0', background: '#f0fdf4', padding: '10px 16px', marginBottom: 16, fontSize: 13, color: '#166534' }}>
          ✓ {confirmedNow} task{confirmedNow === 1 ? '' : 's'} confirmed complete by the latest BrightManager data and moved to Completed.
        </div>
      )}
      {error && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>{error}</div>}

      {/* Comments on tasks — always open, because a collapsed panel is how the
          last five months of them went unread. Newest first, across open and
          completed tasks; click a row to open the task and its full thread. */}
      {view !== 'report' && recentComments.length > 0 && (() => {
        const newIds = new Set(commentsSinceLastVisit.map((n) => n.id));
        const shown = showAllComments ? recentComments : recentComments.slice(0, 6);
        const hidden = recentComments.length - shown.length;
        return (
          <div style={{ ...card, padding: '12px 16px 8px', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <MessageSquare size={14} color="#0e7fe0" />
              <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>Comments on tasks</span>
              {newIds.size > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: '#0e7fe0', background: '#eff6ff', border: '1px solid #bae6fd', borderRadius: 999, padding: '1px 8px' }}>
                  {newIds.size} new
                </span>
              )}
              <span style={{ fontSize: 11.5, color: '#94a3b8', marginLeft: 'auto' }}>
                {recentComments.length} in total
              </span>
            </div>
            {shown.map((n) => (
              <div
                key={n.id}
                onClick={() => navigate(`/planner/tasks/${n.task.id}`)}
                style={{
                  display: 'flex', gap: 10, alignItems: 'baseline', cursor: 'pointer',
                  padding: '7px 8px', borderRadius: 8, borderTop: '1px solid #f1f5f9',
                  background: newIds.has(n.id) ? '#f8fbff' : 'transparent',
                }}
              >
                <span style={{
                  flex: '0 0 6px', height: 6, borderRadius: 3, marginTop: 5,
                  background: newIds.has(n.id) ? '#0e7fe0' : 'transparent',
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: '#0f172a' }}>
                    <span style={{ fontWeight: 700 }}>{n.task.entity?.name || n.task.title}</span>
                    {n.task.entity?.name && (
                      <span style={{ color: '#64748b' }}> · {n.task.title}</span>
                    )}
                    {n.task.done_at && (
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: '#16a34a', marginLeft: 6 }}>COMPLETED</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, color: '#334155', marginTop: 2 }}>
                    {n.kind === 'escalation' && (
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: '#b45309', marginRight: 6 }}>ESCALATION</span>
                    )}
                    {n.body}
                  </div>
                </div>
                <span style={{ flex: '0 0 auto', fontSize: 11.5, color: '#94a3b8' }}>
                  {staffMap[n.author_id] || 'staff'} · {fmtNoteTime(n.created_at)}
                </span>
              </div>
            ))}
            {(hidden > 0 || showAllComments) && (
              <button
                onClick={() => setShowAllComments((v) => !v)}
                style={{ ...btn('ghost'), border: 'none', padding: '6px 2px', fontSize: 11.5 }}
              >
                {showAllComments ? 'Show fewer' : `Show ${hidden} older comment${hidden === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        );
      })()}

      {adding && (
        <div style={{ ...card, padding: '14px 16px', marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false); }}
              placeholder="Task description (required) — e.g. Update year-end date on BM"
              style={{ flex: '2 1 320px', padding: '8px 12px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 8, fontFamily: font, outline: 'none' }}
            />
            <div style={{ flex: '0 0 auto' }}>
              <ClientTypeAhead entityList={allEntities} value={newClient} onChange={setNewClient} onAddNew={openNewClientModal} size="small" />
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#64748b' }} title="Target date">
              <CalendarDays size={13} color="#94a3b8" />
              <input
                type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)}
                style={{ fontSize: 12, fontFamily: font, padding: '6px 8px', borderRadius: 8, border: '1px solid #cbd5e1', color: '#475569', outline: 'none' }}
              />
            </label>
          </div>

          <textarea
            value={newNotes} onChange={(e) => setNewNotes(e.target.value)} rows={2}
            placeholder="Notes (optional)"
            style={{ width: '100%', boxSizing: 'border-box', marginTop: 8, padding: '8px 12px', fontSize: 12.5, border: '1px solid #e2e8f0', borderRadius: 8, fontFamily: font, outline: 'none', resize: 'vertical' }}
          />

          <div style={{ display: 'flex', gap: 16, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#475569', cursor: 'pointer' }}>
              <input type="checkbox" checked={newUrgent} onChange={(e) => setNewUrgent(e.target.checked)} style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#dc2626' }} />
              <Flame size={13} color={newUrgent ? '#dc2626' : '#64748b'} /> Urgent
            </label>

            {/* A span, not a label: the picker is a custom control, and label
                activation would fight its own click handling. */}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#475569' }} title="The service the bill is coded to — the same list the Billing module picks from, and what maps to a QuickBooks product on the push">
              Service
              <ServicePicker
                value={newService}
                options={serviceOptions}
                onChange={setNewService}
                placeholder="— none —"
                style={{ fontSize: 12.5, fontFamily: font, padding: '6px 8px', borderRadius: 8, border: '1px solid #cbd5e1', outline: 'none', width: 240 }}
              />
            </span>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#475569', cursor: 'pointer' }}>
              <input type="checkbox" checked={newBillable} onChange={(e) => setNewBillable(e.target.checked)} style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#0e7fe0' }} />
              <Receipt size={13} color="#64748b" /> Billable — raise a bill
            </label>

            {newBillable && (
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: '#94a3b8' }}>£</span>
                <input
                  type="number" step="0.01" value={newBillAmount} onChange={(e) => setNewBillAmount(e.target.value)}
                  placeholder="Net amount"
                  style={{ width: 120, padding: '7px 10px 7px 20px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 8, fontFamily: font, outline: 'none' }}
                />
              </div>
            )}

            <label style={{ ...btn('ghost'), cursor: 'pointer' }}>
              <Paperclip size={13} /> {newFiles.length ? `${newFiles.length} file${newFiles.length === 1 ? '' : 's'} attached` : 'Attach files'}
              <input type="file" multiple style={{ display: 'none' }}
                onChange={(e) => setNewFiles(Array.from(e.target.files || []))} />
            </label>
            {newFiles.length > 0 && (
              <span style={{ fontSize: 11.5, color: '#94a3b8', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {newFiles.map((f) => f.name).join(', ')}
              </span>
            )}

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {newBillable && !newClient && <span style={{ fontSize: 11.5, color: '#b45309' }}>Billable needs a client</span>}
              <button onClick={() => setAdding(false)} style={btn('ghost')}>Cancel</button>
              <button
                onClick={() => addManual(true)}
                disabled={savingTask || !newTitle.trim() || (newBillable && (!newClient || !billAmountOk(newBillAmount)))}
                title="Save as a draft — held off the live list until you publish it"
                style={{ ...btn('ghost'), opacity: (savingTask || !newTitle.trim()) ? 0.6 : 1 }}
              >Save as draft</button>
              <button
                onClick={() => addManual(false)}
                disabled={savingTask || !newTitle.trim() || (newBillable && (!newClient || !billAmountOk(newBillAmount)))}
                style={{ ...btn('primary'), opacity: (savingTask || !newTitle.trim()) ? 0.6 : 1 }}
              >{savingTask ? 'Adding…' : (newBillable ? 'Add & bill' : 'Add task')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Where admin time goes (completed view) ── */}
      {view === 'completed' && timeSummary && (
        <div style={{ ...card, padding: '12px 16px', marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            Where admin time is going · {Math.round(timeSummary.total / 6) / 10}h recorded across {timeSummary.count} task{timeSummary.count === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px' }}>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>By task type</div>
              {timeSummary.byType.map((r) => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: '#334155', padding: '2px 0' }}>
                  <span>{r.label}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: '#0f172a', fontWeight: 600 }}>{r.minutes}m</span>
                </div>
              ))}
            </div>
            <div style={{ flex: '1 1 260px' }}>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>By client</div>
              {timeSummary.byClient.length === 0 && <div style={{ fontSize: 12, color: '#cbd5e1' }}>No client-linked time yet.</div>}
              {timeSummary.byClient.map((r) => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: '#334155', padding: '2px 0' }}>
                  <span>{r.label}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: '#0f172a', fontWeight: 600 }}>{r.minutes}m</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Report: what's being done each day (replaces the section list) ── */}
      {view === 'report' && (
        <ReportPanel
          completions={reportCompletions}
          created={reportCreatedFiltered}
          loading={reportRows === null}
          staffMap={staffMap}
        />
      )}

      {view !== 'report' && (<>
      {tasks === null && (
        <div style={{ ...card, padding: '18px 16px', marginBottom: 16, textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>Loading…</div>
      )}

      {/* ── Completed view: simple source grouping ── */}
      {view === 'completed' && (<>
        {tasks !== null && completedGroupKeys.length === 0 && (
          <div style={{ ...card, padding: '18px 16px', marginBottom: 16, textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>
            Nothing completed yet.
          </div>
        )}
        {completedGroupKeys.map((key) => (
          <Section
            key={key}
            title={groupLabelFor(key)} count={(groupedCompleted[key] || []).length}
            collapsed={!expandedSet.has(key)} onToggle={() => toggleCollapse(key)}
          >
            {(groupedCompleted[key] || []).map((t) => (
              <CompletedRow
                key={t.id} t={t} staffMap={staffMap}
                onReopen={() => reopen(t)}
                onOpenClient={t.entity?.id ? () => navigate(`/clients/${t.entity.id}`) : null}
                onReviewBill={t.billing_item_id ? () => navigate(`/billing?highlight=${t.billing_item_id}`) : null}
              />
            ))}
          </Section>
        ))}
      </>)}

      {/* ── Open view: Manually generated (pipeline) + System generated ── */}
      {view === 'open' && (<>
        <GroupHeader>Manually generated</GroupHeader>
        {/* Pipeline: Draft → Bill & Hold → Billed → To Do. Managers change a
            task's step with the row dropdown; uploaded tasks land on To Do. */}
        <Section title="Draft — not on the live list" count={draftOpen.length}
          collapsed={!expandedSet.has('draft')} onToggle={() => toggleCollapse('draft')}>
          {draftOpen.length === 0 && <Empty>No drafts.</Empty>}
          {draftOpen.map((t) => taskRow(t, { stageSelect: canPipeline, onAddBill: !t.billing_item_id ? () => setBillTask(t) : null, onRelease: () => publishDraft(t), releaseLabel: 'Publish' }))}
        </Section>
        <Section title="Bill & Hold" count={billHoldOpen.length}
          collapsed={!expandedSet.has('bill_hold')} onToggle={() => toggleCollapse('bill_hold')}>
          {billHoldOpen.length === 0 && <Empty>Nothing waiting on a bill to be raised.</Empty>}
          {billHoldOpen.map((t) => taskRow(t, { stageSelect: canPipeline }))}
        </Section>
        <Section title="Billed — held until paid or released" count={billedOpen.length}
          collapsed={!expandedSet.has('billed')} onToggle={() => toggleCollapse('billed')}>
          {billedOpen.length === 0 && <Empty>Nothing billed and awaiting release.</Empty>}
          {billedOpen.map((t) => taskRow(t, { stageSelect: canPipeline, ...(canPipeline ? { onRelease: () => releaseTask(t), releaseLabel: 'Release to To Do' } : {}) }))}
        </Section>
        <Section title="To Do" count={todoOpen.length}
          collapsed={!expandedSet.has('todo')} onToggle={() => toggleCollapse('todo')}>
          {todoOpen.length === 0 && <Empty>Nothing on the live list.</Empty>}
          {todoOpen.map((t) => taskRow(t, { stageSelect: canPipeline, onAddBill: (!t.billing_item_id && t.entity_id) ? () => setBillTask(t) : null }))}
        </Section>

        {/* Reallocations (capacity planner) — a manual action of ours */}
        <Section
          title="Task reallocations to apply in BM" count={filteredDrafts.length}
          collapsed={!expandedSet.has('realloc')} onToggle={() => toggleCollapse('realloc')}
          action={<button onClick={() => navigate('/planner/allocations')} style={btn('ghost')}>Open capacity planner →</button>}
        >
          {filteredDrafts.length === 0 && <Empty>No reallocation proposals waiting.</Empty>}
          {filteredDrafts.map((d) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderTop: '1px solid #f8fafc', fontSize: 13 }}>
              <span style={{ fontWeight: 600, color: '#0f172a' }}>{entities[d.entity_id] || 'Client'}</span>
              <span style={{ color: '#64748b', flex: 1 }}>{String(d.canonical_service_id || '').replace(/_/g, ' ')}</span>
              <span style={{ color: '#475569', whiteSpace: 'nowrap' }}>→ {staffMap[d.proposed_fee_earner_id] || 'unassigned'}</span>
              <button onClick={() => completeRealloc(d)} title="Mark applied in BM" style={completeBtn(false)}>
                <CheckCircle2 size={13} /> Complete
              </button>
            </div>
          ))}
          {filteredDrafts.length > 0 && (
            <div style={{ padding: '8px 16px', borderTop: '1px solid #f1f5f9', fontSize: 11.5, color: '#94a3b8' }}>
              Marking one complete assumes you've made the change in BM. The next BM upload checks it — if the assignee still doesn't match, it reappears here.
            </div>
          )}
        </Section>

        {/* Onboarding in flight */}
        <Section
          title="Onboarding in flight" count={filteredOnboardings.length}
          collapsed={!expandedSet.has('onboard')} onToggle={() => toggleCollapse('onboard')}
          action={<button onClick={() => navigate('/onboarding')} style={btn('ghost')}>Open onboarding →</button>}
        >
          {filteredOnboardings.length === 0 && <Empty>No onboardings in progress.</Empty>}
          {filteredOnboardings.map((o) => {
            const pct = o.total ? Math.round((o.done / o.total) * 100) : 0;
            return (
              <div key={o.id} onClick={() => navigate(`/onboarding/${o.id}`)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px', borderTop: '1px solid #f8fafc', fontSize: 13, cursor: 'pointer' }}>
                <span style={{ fontWeight: 600, color: '#0f172a', flex: '0 0 190px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {o.entity?.name || 'Client'}
                </span>
                {o.status === 'issues'
                  ? <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, background: '#fee2e2', color: '#b91c1c', fontWeight: 600 }}>Issues</span>
                  : <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, background: '#e0f2fe', color: '#0369a1' }}>Active</span>}
                <div style={{ flex: 1, minWidth: 0, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {o.nextStep ? <>Next: {o.nextStep}</> : 'All steps done'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
                  <div style={{ width: 70, height: 6, background: '#f1f5f9', borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#16a34a' : '#0e7fe0' }} />
                  </div>
                  <span style={{ color: '#94a3b8', fontVariantNumeric: 'tabular-nums', width: 42, textAlign: 'right' }}>{o.done}/{o.total}</span>
                </div>
              </div>
            );
          })}
        </Section>

        {/* Offboarding — mirror tasks from us marking a client NLAC */}
        {offboardingOpen.length > 0 && (
          <Section title="Offboarding — remove from BrightManager" count={offboardingOpen.length}
            collapsed={!expandedSet.has('offboarding')} onToggle={() => toggleCollapse('offboarding')}>
            {offboardingOpen.map((t) => taskRow(t))}
          </Section>
        )}

        <GroupHeader>System generated</GroupHeader>
        {visibleSystemKeys.length === 0 && (
          <div style={{ ...card, padding: '18px 16px', marginBottom: 16, textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>
            No data issues flagged — Athena and BrightManager are in step. 🎉
          </div>
        )}
        {visibleSystemKeys.map((key) => (
          <Section
            key={key}
            title={groupLabelFor(key)} count={(systemGroups[key] || []).length}
            collapsed={!expandedSet.has(key)} onToggle={() => toggleCollapse(key)}
          >
            {(systemGroups[key] || []).map((t) => taskRow(t))}
          </Section>
        ))}

      {/* ── CH personal code chases (live from the ch-codes module) ── */}
      <Section
        title="CH personal code chases" count={filteredChCodes.length}
        collapsed={!expandedSet.has('chcodes')} onToggle={() => toggleCollapse('chcodes')}
        action={<button onClick={() => navigate('/onboarding/ch-codes')} style={btn('ghost')}>Open CH codes →</button>}
      >
        {filteredChCodes.length === 0 && <Empty>No code chases in flight.</Empty>}
        {filteredChCodes.map((r) => {
          const meta = stageMeta(r.stage);
          return (
            <div key={r.id} onClick={() => navigate(`/onboarding/ch-codes/${r.id}`)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderTop: '1px solid #f8fafc', fontSize: 13, cursor: 'pointer' }}>
              <KeyRound size={13} color="#94a3b8" style={{ flexShrink: 0 }} />
              <span style={{ fontWeight: 600, color: '#0f172a', flex: '0 0 190px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.person?.name || 'Person'}
              </span>
              <span style={{ color: '#64748b', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {(r.entities && r.entities.length ? r.entities.join(', ') : r.entity?.name) || ''}
              </span>
              <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, background: '#e0f2fe', color: '#0369a1', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {meta.short} · {meta.label}
              </span>
              <span style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {r.emails_sent ? `${r.emails_sent} email${r.emails_sent === 1 ? '' : 's'} sent` : 'no emails yet'}
              </span>
            </div>
          );
        })}
      </Section>

      </>)}
      </>)}

      {escalateTask && (
        <EscalateModal
          task={escalateTask}
          staffList={staffList}
          onClose={() => setEscalateTask(null)}
          onSend={submitEscalation}
        />
      )}

      {completeTask && (
        <CompleteModal
          task={completeTask}
          staffList={staffList}
          defaultStaffId={profile?.id || ''}
          onClose={() => setCompleteTask(null)}
          onConfirm={(doneBy, minutes) => { complete(completeTask, { doneBy, minutes }); setCompleteTask(null); }}
        />
      )}

      {billTask && (
        <AddBillModal
          task={billTask}
          serviceOptions={serviceOptions}
          standardNetFor={feeFor}
          onClose={() => setBillTask(null)}
          onConfirm={(answers) => { addBillToTask(billTask, answers); setBillTask(null); }}
        />
      )}

      <NewClientModal
        open={newClientModal.open}
        initialName={newClientModal.initialName}
        onClose={handleNewClientClose}
        onSave={handleNewClientSave}
      />
    </div>
  );
}

// Raising a bill off a task needs the two things a task does not necessarily
// carry: which service the bill is coded to, and what it is worth.
function AddBillModal({ task, serviceOptions, standardNetFor, onClose, onConfirm }) {
  const [serviceId, setServiceId] = useState(task.service_id || '');
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState('');

  const known = !!serviceId && serviceOptions.some((o) => o.id === serviceId);
  const std = known ? standardNetFor(serviceId) : null;
  const typed = String(amount).trim();
  const net = typed === '' ? (std ?? 0) : parseFloat(typed);
  const netOk = Number.isFinite(net) && net >= 0;
  const vat = netOk ? Math.round(net * VAT_RATE * 100) / 100 : 0;

  const submit = (hold) => {
    if (!serviceId) { setErr('Pick the service this work was — it decides the QuickBooks product the bill lands on.'); return; }
    if (!known) { setErr(`"${serviceId}" is not a service Billing offers — pick one from the list.`); return; }
    if (!netOk) { setErr('Enter a net amount of 0 or more.'); return; }
    onConfirm({ serviceId, net, hold });
  };

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modalCard, width: 460 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Receipt size={16} color="#0e7fe0" /> Raise a bill
        </div>
        <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 14 }}>
          {task.entity?.name ? `${task.entity.name} — ` : ''}{task.title}
        </div>

        <label style={fieldLabel}>Service</label>
        <ServicePicker
          value={serviceId}
          options={serviceOptions}
          onChange={(v) => { setServiceId(v); setErr(''); }}
          placeholder="Pick the service the work actually was"
          style={selectInput}
        />

        <label style={{ ...fieldLabel, marginTop: 12 }}>Net amount (excl. VAT)</label>
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: '#94a3b8' }}>£</span>
          <input
            type="number" step="0.01" min="0" value={amount} autoFocus
            onChange={(e) => { setAmount(e.target.value); setErr(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(true); }}
            placeholder={std != null ? `Standard fee ${std}` : '0.00'}
            style={{ ...selectInput, paddingLeft: 20 }}
          />
        </div>
        <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 6 }}>
          {netOk
            ? `£${net.toFixed(2)} + £${vat.toFixed(2)} VAT = £${(net + vat).toFixed(2)} gross. `
            : 'Enter a net amount of 0 or more. '}
          Blank or 0 raises a placeholder — Billing will not approve or push a £0.00 bill.
        </div>

        {err && <div style={{ fontSize: 12.5, color: '#b91c1c', marginTop: 10 }}>{err}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button onClick={onClose} style={btn('ghost')}>Cancel</button>
          <button
            onClick={() => submit(false)}
            title="Raise the bill but leave the task where it is — the work is not finished just because it has been billed"
            style={{ ...btn('ghost'), color: '#0e7fe0', borderColor: '#bae6fd' }}
          >
            <Receipt size={13} /> Bill and leave on To Do
          </button>
          <button onClick={() => submit(true)} title="Raise the bill and move the task to Bill and Hold, off the live list" style={btn('primary')}>
            <Receipt size={13} /> Bill and Hold
          </button>
        </div>
      </div>
    </div>
  );
}

const MINUTE_PRESETS = [5, 10, 15, 30, 45, 60];

function CompleteModal({ task, staffList, defaultStaffId, onClose, onConfirm }) {
  const [doneBy, setDoneBy] = useState(defaultStaffId);
  const [minutes, setMinutes] = useState(null);
  const [custom, setCustom] = useState('');

  const effectiveMinutes = custom !== '' ? parseInt(custom, 10) || 0 : minutes;

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modalCard, width: 420 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
          <CheckCircle2 size={16} color="#16a34a" /> Complete task
        </div>
        <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 14 }}>{task.title}</div>

        <label style={fieldLabel}>Who did it?</label>
        <select value={doneBy} onChange={(e) => setDoneBy(e.target.value)} style={selectInput}>
          {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <label style={{ ...fieldLabel, marginTop: 12 }}>How long did it take?</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {MINUTE_PRESETS.map((m) => (
            <button key={m} onClick={() => { setMinutes(m); setCustom(''); }}
              style={{
                padding: '6px 12px', fontSize: 12.5, fontWeight: 600, fontFamily: font, borderRadius: 8, cursor: 'pointer',
                background: minutes === m && custom === '' ? '#0f172a' : '#fff',
                color: minutes === m && custom === '' ? '#fff' : '#475569',
                border: `1px solid ${minutes === m && custom === '' ? '#0f172a' : '#e5e7eb'}`,
              }}>{m}m</button>
          ))}
          <input
            type="number" min="1" value={custom} placeholder="Other"
            onChange={(e) => { setCustom(e.target.value); setMinutes(null); }}
            style={{ width: 70, padding: '6px 8px', fontSize: 12.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, outline: 'none' }}
          />
        </div>
        <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 8 }}>
          Recorded against the task — builds the picture of where admin time goes, by task type and client.
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={btn('ghost')}>Cancel</button>
          <button onClick={() => onConfirm(doneBy, effectiveMinutes)} disabled={!doneBy || !effectiveMinutes}
            style={{ ...btn('primary'), opacity: (!doneBy || !effectiveMinutes) ? 0.6 : 1 }}>
            <CheckCircle2 size={13} /> Complete
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskRow({
  t, notes, notesOpen, docs, staffMap, copied,
  onComplete, onCopy, onDismiss, onDeadline, onToggleNotes, onAddNote, onEscalate,
  onToggleUrgent, onAttach, onOpenDoc, onDeleteDoc, onOpenClient, onReviewBill,
  onAddBill, onRelease, releaseLabel, onSetStage, stageSelect, onOpen,
}) {
  const [noteDraft, setNoteDraft] = useState('');
  const today = isoToday();
  const overdue = t.deadline && t.deadline < today;
  const urgent = !!t.urgent;
  const addedBy = addedByLabel(t, staffMap);

  return (
    <div style={{
      borderTop: '1px solid #f8fafc',
      background: urgent ? '#fef2f2' : undefined,
      boxShadow: urgent ? 'inset 3px 0 0 #dc2626' : undefined,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          {urgent && (
            <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 999, background: '#dc2626', color: '#fff', fontWeight: 700, letterSpacing: 0.5, whiteSpace: 'nowrap', flexShrink: 0 }}>
              URGENT
            </span>
          )}
          <span
            onClick={onOpen || undefined}
            style={{
              fontSize: 13.5, fontWeight: 600, color: '#0f172a', cursor: onOpen ? 'pointer' : 'default',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
            title={onOpen ? 'Open task detail' : t.title}
          >{t.entity?.name && !(t.title || '').toLowerCase().includes(t.entity.name.toLowerCase()) ? `${t.entity.name} — ` : ''}{t.title}</span>
          {t.detail && (
            <span
              onClick={onToggleNotes}
              title={t.detail}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                width: 16, height: 16, borderRadius: 999, background: '#eef2ff', color: '#4338ca',
                fontSize: 10.5, fontWeight: 700, cursor: 'pointer',
              }}
            >i</span>
          )}
          {t.escalated_to && (
            <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 999, background: '#fef3c7', color: '#b45309', fontWeight: 600, whiteSpace: 'nowrap' }}>
              → {staffMap[t.escalated_to] || 'escalated'}
            </span>
          )}
          {addedBy && (
            <span
              title={`Added by ${addedBy} · ${fmtShort(t.created_at)}`}
              style={{
                fontSize: 10.5, padding: '1px 7px', borderRadius: 999, background: '#f1f5f9',
                color: '#64748b', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, cursor: 'default',
              }}
            >{addedBy}</span>
          )}
        </div>

        {/* Copy chip is for values Sophie keys into BM (codes, UTRs) — internal
            bookkeeping values like the dedup pair ids stay hidden. */}
        {t.value && t.source !== 'person_dedup' && (
          <button onClick={onCopy} title="Copy the value to paste into BM" style={{ ...btn('ghost'), fontFamily: 'monospace', fontSize: 12, flexShrink: 0 }}>
            {copied ? '✓ copied' : <>{t.value} <Copy size={11} /></>}
          </button>
        )}

        {onReviewBill && (
          <button onClick={onReviewBill} title="Open the bill raised for this task" style={{ ...btn('ghost'), color: '#0e7fe0', borderColor: '#bae6fd', flexShrink: 0 }}>
            <Receipt size={12} /> Review bill
          </button>
        )}

        {onAddBill && (
          <button onClick={onAddBill} title="Raise a bill for this task — creates a draft in the Billing Module, and you choose whether the task is held or stays on the list" style={{ ...btn('ghost'), color: '#0e7fe0', borderColor: '#bae6fd', flexShrink: 0 }}>
            <Receipt size={12} /> Add bill
          </button>
        )}

        {onRelease && (
          <button onClick={onRelease} title={releaseLabel || 'Release to To Do'} style={{ ...btn('ghost'), color: '#166534', borderColor: '#bbf7d0', flexShrink: 0, whiteSpace: 'nowrap' }}>
            {releaseLabel || 'Release'} →
          </button>
        )}

        {stageSelect && (
          <select
            value={t.stage || 'todo'}
            onChange={(e) => onSetStage && onSetStage(e.target.value)}
            title="Move this task to another pipeline step"
            style={{ fontSize: 11.5, fontFamily: font, padding: '3px 6px', borderRadius: 6, border: '1px solid #e2e8f0', color: '#475569', background: '#fff', outline: 'none', flexShrink: 0 }}
          >
            <option value="draft">Draft</option>
            <option value="bill_hold">Bill &amp; Hold</option>
            <option value="billed">Billed</option>
            <option value="todo">To Do</option>
          </select>
        )}

        {/* Deadline — kept directly next to the comments button below, so the
            date column stays aligned across rows regardless of whether the
            copy-value / Review bill buttons above are present. */}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }} title="Set a deadline">
          <CalendarDays size={13} color={overdue ? '#dc2626' : '#94a3b8'} />
          <input
            type="date" value={t.deadline || ''} onChange={(e) => onDeadline(e.target.value)}
            style={{
              fontSize: 11.5, fontFamily: font, padding: '3px 6px', borderRadius: 6,
              border: `1px solid ${overdue ? '#fca5a5' : '#e2e8f0'}`, color: overdue ? '#dc2626' : '#475569',
              background: overdue ? '#fef2f2' : '#fff', outline: 'none',
            }}
          />
        </label>

        <button onClick={onToggleNotes} title="Notes & responses"
          style={{ ...iconBtn, color: notes.length ? '#0e7fe0' : '#94a3b8', borderColor: notes.length ? '#bae6fd' : '#e5e7eb' }}>
          <MessageSquare size={13} />{notes.length > 0 && <span style={{ fontSize: 11, fontWeight: 700 }}>{notes.length}</span>}
        </button>

        <button onClick={onToggleUrgent} title={urgent ? 'Remove urgent flag' : 'Mark as urgent'}
          style={{ ...iconBtn, color: urgent ? '#dc2626' : '#94a3b8', borderColor: urgent ? '#fecaca' : '#e5e7eb', background: urgent ? '#fee2e2' : '#fff' }}>
          <Flame size={13} />
        </button>

        <label title="Attach a file" style={{ ...iconBtn, color: docs.length ? '#0e7fe0' : '#94a3b8', borderColor: docs.length ? '#bae6fd' : '#e5e7eb', cursor: 'pointer' }}>
          <Paperclip size={13} />{docs.length > 0 && <span style={{ fontSize: 11, fontWeight: 700 }}>{docs.length}</span>}
          <input type="file" multiple style={{ display: 'none' }} onChange={(e) => { onAttach(e.target.files); e.target.value = ''; }} />
        </label>

        <button onClick={onEscalate} title="Escalate — ask someone to action this" style={{ ...iconBtn, color: '#b45309', borderColor: '#fde68a' }}>
          <AlertTriangle size={13} />
        </button>

        <button
          onClick={onComplete}
          title="Mark as entered into BrightManager — moves to the Completed tab"
          style={completeBtn(false)}
        >
          <CheckCircle2 size={13} /> Complete
        </button>

        <button onClick={onDismiss} title="Remove without completing" style={{ background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer', padding: 2, display: 'flex', flexShrink: 0 }}>
          <X size={14} />
        </button>
      </div>

      {docs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '0 16px 8px 26px' }}>
          {docs.map((d) => (
            <span key={d.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5,
              padding: '2px 8px', borderRadius: 999, background: '#eff6ff', color: '#0e7fe0', border: '1px solid #dbeafe',
            }}>
              <Paperclip size={11} />
              <span onClick={() => onOpenDoc(d)} style={{ cursor: 'pointer', textDecoration: 'underline', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {d.original_name}
              </span>
              <X size={11} style={{ cursor: 'pointer', color: '#94a3b8' }} onClick={() => onDeleteDoc(d)} />
            </span>
          ))}
        </div>
      )}

      {notesOpen && (
        <div style={{ padding: '4px 16px 12px 46px', background: '#fafbfc' }}>
          {t.detail && (
            <div style={{ fontSize: 12.5, color: '#475569', padding: '6px 0', borderBottom: '1px solid #f1f5f9', whiteSpace: 'pre-wrap' }}>
              {t.detail}
            </div>
          )}
          {notes.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8', padding: '4px 0' }}>No notes yet.</div>}
          {notes.map((n) => (
            <div key={n.id} style={{ fontSize: 12.5, color: '#334155', padding: '4px 0', display: 'flex', gap: 8 }}>
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 4, flexShrink: 0, height: 16, alignSelf: 'flex-start', marginTop: 1,
                background: n.kind === 'escalation' ? '#fef3c7' : '#eef2ff', color: n.kind === 'escalation' ? '#b45309' : '#4338ca',
              }}>{n.kind === 'escalation' ? 'escalation' : 'note'}</span>
              <div>
                <span>{n.body}</span>
                <span style={{ color: '#94a3b8', marginLeft: 6, fontSize: 11 }}>
                  — {staffMap[n.author_id] || 'staff'} · {fmtNoteTime(n.created_at)}
                </span>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input
              value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && noteDraft.trim()) { onAddNote(noteDraft); setNoteDraft(''); } }}
              placeholder="Add a note or response…"
              style={{ flex: 1, fontSize: 12.5, fontFamily: font, padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 8, outline: 'none' }}
            />
            <button onClick={() => { if (noteDraft.trim()) { onAddNote(noteDraft); setNoteDraft(''); } }}
              disabled={!noteDraft.trim()} style={{ ...btn('primary'), padding: '6px 12px' }}><Send size={12} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

function CompletedRow({ t, staffMap, onReopen, onOpenClient, onReviewBill }) {
  // Verification status: BM checks tasks with a field silently on each import;
  // field-less tasks confirm the moment they're completed.
  const badge = !t.field
    ? { text: 'Done', bg: '#dcfce7', fg: '#166534', hint: 'Completed — nothing for BrightManager to verify.' }
    : t.confirmed_at
      ? { text: '✓ Confirmed in BM', bg: '#dcfce7', fg: '#166534', hint: 'The BrightManager data now holds this value.' }
      : { text: 'Awaiting BM check', bg: '#fef3c7', fg: '#b45309', hint: 'The next BrightManager upload verifies this silently.' };
  const when = t.confirmed_at || t.done_at;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderTop: '1px solid #f8fafc' }}>
      <CheckCircle2 size={14} color="#16a34a" style={{ flexShrink: 0 }} />
      <span
        onClick={onOpenClient || undefined} title={t.title}
        style={{
          flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: '#334155',
          cursor: onOpenClient ? 'pointer' : 'default', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >{t.title}</span>
      {t.value && <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#94a3b8', flexShrink: 0 }}>{t.value}</span>}
      {addedByLabel(t, staffMap) && (
        <span title={`Added by ${addedByLabel(t, staffMap)} · ${fmtShort(t.created_at)}`} style={{
          fontSize: 10.5, padding: '1px 7px', borderRadius: 999, background: '#f1f5f9',
          color: '#64748b', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, cursor: 'default',
        }}>{addedByLabel(t, staffMap)}</span>
      )}
      {(t.done_by || t.done_minutes) && (
        <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {t.done_by ? ((staffMap && staffMap[t.done_by]) || 'staff') : ''}{t.done_minutes ? ` · ${t.done_minutes}m` : ''}
        </span>
      )}
      <span title={badge.hint} style={{
        fontSize: 10.5, padding: '2px 8px', borderRadius: 999, background: badge.bg, color: badge.fg,
        fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, cursor: 'default',
      }}>{badge.text}</span>
      <span style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtShort(when)}</span>
      {onReviewBill && (
        <button onClick={onReviewBill} title="Open the bill raised for this task" style={{ ...btn('ghost'), color: '#0e7fe0', borderColor: '#bae6fd', padding: '5px 10px', fontSize: 12 }}>
          <Receipt size={12} /> Review bill
        </button>
      )}
      <button onClick={onReopen} title="Move back to open tasks" style={{ ...btn('ghost'), padding: '5px 10px', fontSize: 12 }}>
        <RotateCcw size={12} /> Reopen
      </button>
    </div>
  );
}

/* ── Report: activity across the admin list, last two weeks ──
   Bars = tasks completed per day; the thin bar beside each is tasks
   created that day, so a growing backlog shows up at a glance. */
function localDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ReportPanel({ completions, created, loading, staffMap }) {
  const days = useMemo(() => {
    const out = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      out.push({
        key: localDayKey(d),
        label: `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.getDate()}`,
        isToday: i === 0,
        done: 0,
        added: 0,
      });
    }
    const byKey = Object.fromEntries(out.map((d) => [d.key, d]));
    for (const t of completions) {
      const k = t.done_at && byKey[localDayKey(new Date(t.done_at))];
      if (k) k.done += 1;
    }
    for (const t of created) {
      const k = t.created_at && byKey[localDayKey(new Date(t.created_at))];
      if (k) k.added += 1;
    }
    return out;
  }, [completions, created]);

  const summary = useMemo(() => {
    const thisWeek = days.slice(7).reduce((s, d) => s + d.done, 0);
    const lastWeek = days.slice(0, 7).reduce((s, d) => s + d.done, 0);
    const weekKeys = new Set(days.slice(7).map((d) => d.key));
    const minutesThisWeek = completions.reduce((s, t) => (
      t.done_at && weekKeys.has(localDayKey(new Date(t.done_at))) ? s + (t.done_minutes || 0) : s
    ), 0);
    let busiest = null;
    for (const d of days) if (d.done > 0 && d.done > (busiest?.done || 0)) busiest = d;
    return { thisWeek, lastWeek, delta: thisWeek - lastWeek, minutesThisWeek, busiest };
  }, [days, completions]);

  const byPerson = useMemo(() => {
    const m = new Map();
    for (const t of completions) {
      const k = t.done_by || 'unknown';
      const r = m.get(k) || { id: k, count: 0, minutes: 0, timed: 0 };
      r.count += 1;
      if (t.done_minutes > 0) { r.minutes += t.done_minutes; r.timed += 1; }
      m.set(k, r);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [completions]);

  const byType = useMemo(() => {
    const m = new Map();
    for (const t of completions) {
      const k = groupKeyFor(t);
      const r = m.get(k) || { key: k, count: 0, minutes: 0 };
      r.count += 1;
      r.minutes += t.done_minutes || 0;
      m.set(k, r);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [completions]);

  if (loading) {
    return <div style={{ ...card, padding: '18px 16px', marginBottom: 16, textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>Building report…</div>;
  }

  // Chart geometry — one slot per day, main bar (completions) + thin bar (created).
  const slotW = 58, barArea = 110, topPad = 18, bottomPad = 24;
  const chartW = days.length * slotW;
  const chartH = topPad + barArea + bottomPad;
  const baseY = topPad + barArea;
  const maxVal = Math.max(1, ...days.map((d) => Math.max(d.done, d.added)));
  const deltaTone = summary.delta > 0 ? '#166534' : summary.delta < 0 ? '#b91c1c' : '#64748b';
  const deltaText = summary.delta === 0
    ? 'level with last week'
    : `${summary.delta > 0 ? '▲' : '▼'} ${Math.abs(summary.delta)} vs last week (${summary.lastWeek})`;

  return (
    <>
      <div style={{ fontSize: 12.5, color: '#94a3b8', marginBottom: 12 }}>
        What's being done each day across the admin list — last two weeks.
      </div>

      {/* Summary tiles */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ ...card, padding: '12px 18px', flex: '1 1 180px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>Completed this week</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>{summary.thisWeek}</div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: deltaTone }}>{deltaText}</div>
        </div>
        <div style={{ ...card, padding: '12px 18px', flex: '1 1 180px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>Minutes recorded this week</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>{summary.minutesThisWeek}m</div>
          <div style={{ fontSize: 11.5, color: '#94a3b8' }}>{Math.round(summary.minutesThisWeek / 6) / 10}h across timed tasks</div>
        </div>
        <div style={{ ...card, padding: '12px 18px', flex: '1 1 180px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>Busiest day</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>{summary.busiest ? summary.busiest.label : '—'}</div>
          <div style={{ fontSize: 11.5, color: '#94a3b8' }}>{summary.busiest ? `${summary.busiest.done} completion${summary.busiest.done === 1 ? '' : 's'}` : 'nothing completed yet'}</div>
        </div>
      </div>

      {/* Actions per day chart */}
      <div style={{ ...card, padding: '14px 16px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Actions taken per day
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#64748b' }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: '#93c5fd', display: 'inline-block' }} /> completed
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#64748b' }}>
            <span style={{ width: 5, height: 10, borderRadius: 2, background: '#cbd5e1', display: 'inline-block' }} /> added
          </span>
        </div>
        <svg width="100%" viewBox={`0 0 ${chartW} ${chartH}`} style={{ display: 'block' }}>
          <line x1={0} x2={chartW} y1={baseY} y2={baseY} stroke="#e5e7eb" strokeWidth={1} />
          {days.map((d, i) => {
            const x = i * slotW;
            const dh = Math.round((d.done / maxVal) * barArea);
            const ah = Math.round((d.added / maxVal) * barArea);
            return (
              <g key={d.key}>
                {d.done > 0 && (
                  <rect x={x + 9} y={baseY - dh} width={26} height={dh} rx={3}
                    fill={d.isToday ? '#0e7fe0' : '#93c5fd'} />
                )}
                {d.added > 0 && (
                  <rect x={x + 39} y={baseY - ah} width={7} height={ah} rx={2} fill="#cbd5e1" />
                )}
                {d.done > 0 && (
                  <text x={x + 22} y={baseY - dh - 5} textAnchor="middle" fontSize={10.5}
                    fontFamily={font} fontWeight={d.isToday ? 700 : 600} fill="#475569">
                    {d.done}
                  </text>
                )}
                <text x={x + 27} y={baseY + 16} textAnchor="middle" fontSize={10.5}
                  fontFamily={font} fontWeight={d.isToday ? 700 : 500}
                  fill={d.isToday ? '#0f172a' : '#94a3b8'}>
                  {d.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {completions.length === 0 && (
        <div style={{ ...card, padding: '18px 16px', marginBottom: 16, textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>
          Nothing completed in the last two weeks{created.length ? ` — though ${created.length} task${created.length === 1 ? ' was' : 's were'} added` : ''}.
        </div>
      )}

      {/* By person + by type */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ ...card, flex: '1 1 340px', overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #f1f5f9' }}>
            By person
          </div>
          {byPerson.length === 0 && <Empty>No completions to show.</Empty>}
          {byPerson.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={reportTh}>Person</th>
                  <th style={{ ...reportTh, textAlign: 'right' }}>Completions</th>
                  <th style={{ ...reportTh, textAlign: 'right' }}>Minutes</th>
                  <th style={{ ...reportTh, textAlign: 'right' }}>Avg</th>
                </tr>
              </thead>
              <tbody>
                {byPerson.map((r) => (
                  <tr key={r.id}>
                    <td style={reportTd}>{r.id === 'unknown' ? 'Not recorded' : (staffMap[r.id] || 'Staff')}</td>
                    <td style={{ ...reportTd, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{r.count}</td>
                    <td style={{ ...reportTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.minutes ? `${r.minutes}m` : '—'}</td>
                    <td style={{ ...reportTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.timed ? `${Math.round(r.minutes / r.timed)}m` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ ...card, flex: '1 1 340px', overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #f1f5f9' }}>
            By task type
          </div>
          {byType.length === 0 && <Empty>No completions to show.</Empty>}
          {byType.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={reportTh}>Type</th>
                  <th style={{ ...reportTh, textAlign: 'right' }}>Completions</th>
                  <th style={{ ...reportTh, textAlign: 'right' }}>Minutes</th>
                </tr>
              </thead>
              <tbody>
                {byType.map((r) => (
                  <tr key={r.key}>
                    <td style={reportTd}>{groupLabelFor(r.key)}</td>
                    <td style={{ ...reportTd, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{r.count}</td>
                    <td style={{ ...reportTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.minutes ? `${r.minutes}m` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

const reportTh = {
  padding: '7px 16px', fontSize: 11, fontWeight: 600, color: '#64748b',
  textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4,
  borderBottom: '1px solid #f1f5f9', whiteSpace: 'nowrap',
};
const reportTd = { padding: '7px 16px', color: '#334155', borderBottom: '1px solid #f8fafc' };

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 11px', fontSize: 11.5, fontWeight: 600, fontFamily: font, borderRadius: 999, cursor: 'pointer',
      background: active ? '#0f172a' : '#fff', color: active ? '#fff' : '#64748b',
      border: `1px solid ${active ? '#0f172a' : '#e5e7eb'}`, whiteSpace: 'nowrap',
    }}>{children}</button>
  );
}

function EscalateModal({ task, staffList, onClose, onSend }) {
  const [toId, setToId] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    if (!toId) return;
    setSending(true);
    const ok = await onSend(task, toId, note.trim());
    setSending(false);
    if (ok) onClose();
  }

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modalCard, width: 440 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={16} color="#b45309" /> Escalate task
        </div>
        <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 14 }}>{task.title}</div>

        <label style={fieldLabel}>Who needs to action this?</label>
        <select value={toId} onChange={(e) => setToId(e.target.value)} style={selectInput}>
          <option value="">— Select a person —</option>
          {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <label style={{ ...fieldLabel, marginTop: 12 }}>Note (what needs doing)</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder="Give them the context they need to act."
          style={{ ...selectInput, resize: 'vertical' }} />

        <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 8 }}>
          Sends them an email with the task and your note, and logs it on the task thread.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={btn('ghost')}>Cancel</button>
          <button onClick={send} disabled={!toId || sending} style={{ ...btn('primary'), opacity: (!toId || sending) ? 0.6 : 1 }}>
            <Send size={13} /> {sending ? 'Sending…' : 'Send & escalate'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, count, collapsed, onToggle, action, children }) {
  return (
    <div style={{ ...card, overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 16px', borderBottom: collapsed ? 'none' : '1px solid #f1f5f9' }}>
        <button onClick={onToggle} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginRight: 8, color: '#64748b', display: 'flex' }}>
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <span onClick={onToggle} style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1, cursor: 'pointer' }}>
          {title} ({count})
        </span>
        {action}
      </div>
      {!collapsed && children}
    </div>
  );
}

function Chip({ label, value, tone = 'default' }) {
  const tones = {
    default: { bg: '#f1f5f9', fg: '#0f172a' },
    muted: { bg: '#f8fafc', fg: '#94a3b8' },
    red: { bg: '#fee2e2', fg: '#b91c1c' },
    amber: { bg: '#fef3c7', fg: '#b45309' },
    blue: { bg: '#e0f2fe', fg: '#0369a1' },
  };
  const c = tones[tone] || tones.default;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '5px 12px', borderRadius: 999, background: c.bg }}>
      <span style={{ fontSize: 15, fontWeight: 700, color: c.fg, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      <span style={{ fontSize: 11.5, color: c.fg, opacity: 0.85 }}>{label}</span>
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ padding: '18px 16px', fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>{children}</div>;
}

// Top-level group divider (Manually generated / System generated).
function GroupHeader({ children }) {
  return (
    <div style={{
      fontSize: 12.5, fontWeight: 800, color: '#334155', textTransform: 'uppercase',
      letterSpacing: 0.6, margin: '24px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e5e7eb',
    }}>
      {children}
    </div>
  );
}

function btn(kind) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', fontSize: 12.5, fontWeight: 600,
    fontFamily: font, borderRadius: 8, cursor: 'pointer',
    background: kind === 'primary' ? '#0f172a' : '#fff',
    color: kind === 'primary' ? '#fff' : '#475569',
    border: kind === 'primary' ? 'none' : '1px solid #e5e7eb',
  };
}
const iconBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 3, padding: '4px 7px', fontFamily: font,
  borderRadius: 7, cursor: 'pointer', background: '#fff', border: '1px solid #e5e7eb', flexShrink: 0,
};
function completeBtn(active) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', fontSize: 12, fontWeight: 600,
    fontFamily: font, borderRadius: 7, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
    background: active ? '#dcfce7' : '#fff', color: active ? '#166534' : '#475569',
    border: `1px solid ${active ? '#bbf7d0' : '#e5e7eb'}`,
  };
}
const modalBackdrop = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const modalCard = { background: '#fff', borderRadius: 12, padding: '20px 22px', fontFamily: font, boxShadow: '0 20px 60px rgba(15,23,42,0.25)' };
const fieldLabel = { display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 4 };
const selectInput = {
  width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1',
  borderRadius: 8, background: '#fff', color: '#0f172a', boxSizing: 'border-box', outline: 'none',
};
