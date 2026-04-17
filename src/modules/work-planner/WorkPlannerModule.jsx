import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../shell/AppShell';
import {
  fetchQuickTasks, insertQuickTask, updateQuickTask as updateQuickTaskDb,
  deleteQuickTask as deleteQuickTaskDb, reorderQuickTasks as reorderQuickTasksDb,
  fetchScheduledTasks, insertScheduledTask, updateScheduledTask as updateScheduledTaskDb,
  deleteScheduledTask as deleteScheduledTaskDb,
  fetchInstanceOverrides, upsertInstanceOverride, deleteInstanceOverride,
  fetchCompletedTasks, insertCompletedTask,
  fetchProgressNotes, insertProgressNote,
  fetchStaffProfiles, fetchEntities, insertEntity,
  subscribeToWorkPlanner,
} from './lib/supabaseQueries';
import { instanceKey, generateInstances } from './lib/instanceEngine';
import { formatISO, today, addDays, addMonths, startOfWeek, countWorkingDaysSince } from './lib/helpers';
import { defaultDuration, CALENDAR_VIEWS } from './lib/constants';

import FilterBar from './components/FilterBar';
import ActionPopover from './components/ActionPopover';
import CompleteModal from './components/CompleteModal';
import MasterModal from './components/MasterModal';
import InstanceModal from './components/InstanceModal';
import QuickTaskModal from './components/QuickTaskModal';

import NewClientModal from '../../components/NewClientModal';
// Colour settings now stored on staff_profiles.colour (Supabase), managed in Admin page

import QuickTasksView from './views/QuickTasksView';
import ScheduledView from './views/ScheduledView';
import CalendarView from './views/CalendarView';
import KanbanView from './views/KanbanView';
import CompletedView from './views/CompletedView';
import MyTasksView from './views/MyTasksView';

// ── Context ──
const WorkPlannerContext = createContext(null);
export function useWorkPlanner() { return useContext(WorkPlannerContext); }

// ── Tab config ──
const TABS = [
  { id: 'mytasks', label: 'My Tasks', path: '/planner' },
  { id: 'quick', label: 'Quick Tasks', path: '/planner/quick' },
  { id: 'sched', label: 'Scheduled', path: '/planner/scheduled' },
  { id: 'calendar', label: 'Calendar', path: '/planner/calendar' },
  { id: 'kanban', label: 'Kanban', path: '/planner/kanban' },
  { id: 'completed', label: 'Completed', path: '/planner/completed' },
];

export default function WorkPlannerModule() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // ── Data state ──
  const [quickTasks, setQuickTasks] = useState([]);
  const [scheduledTasks, setScheduledTasks] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [completedTasks, setCompletedTasks] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [entityList, setEntityList] = useState([]);
  const [progressNotes, setProgressNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ── UI state ──
  const [teamFilter, setTeamFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [calendarView, setCalendarView] = useState('workweek');
  const [anchor, setAnchor] = useState(new Date(today()));
  const [dueFilter, setDueFilter] = useState('month');
  const [sourceFilter, setSourceFilter] = useState('');
  const [compact, setCompact] = useState(false);
  const [sort, setSort] = useState('next');
  const [colourMode, setColourMode] = useState('staff'); // 'staff' | 'status'
  const [statusColours] = useState({}); // future: stored in portal_settings table
  const [modal, setModal] = useState(null); // null | 'new' | masterObject
  const [instanceModal, setInstanceModal] = useState(null);
  const [quickModal, setQuickModal] = useState(null); // null | quickTaskObject
  const [popover, setPopover] = useState(null);
  const [completeModal, setCompleteModal] = useState(null);
  const [highlightId, setHighlightId] = useState(null);
  const [newClientModal, setNewClientModal] = useState({ open: false, initialName: '', resolve: null });

  // ── Determine active tab from URL ──
  const activeTab = useMemo(() => {
    const path = location.pathname;
    const tab = TABS.find((t) => t.path === path);
    return tab ? tab.id : 'mytasks';
  }, [location.pathname]);

  // ── Derived: overridesMap and completedKeys ──
  const overridesMap = useMemo(() => {
    const map = new Map();
    overrides.forEach((ov) => {
      const key = instanceKey(ov.master_id, ov.occurrence_date);
      map.set(key, ov);
    });
    return map;
  }, [overrides]);

  const completedKeys = useMemo(() => {
    const set = new Set();
    completedTasks.forEach((ct) => {
      if (ct.source_type === 'scheduled_instance' && ct.source_id && ct.occurrence_date) {
        set.add(instanceKey(ct.source_id, ct.occurrence_date));
      }
    });
    return set;
  }, [completedTasks]);

  // ── Derived: lookup maps ──
  const staffMap = useMemo(() => {
    const m = {};
    staffList.forEach((s) => { m[s.id] = s; });
    return m;
  }, [staffList]);

  const entityMap = useMemo(() => {
    const m = {};
    entityList.forEach((e) => { m[e.id] = e; });
    return m;
  }, [entityList]);

  // Staff colours derived from staff_profiles.colour column (set in Admin page)
  const staffColours = useMemo(() => {
    const m = {};
    staffList.forEach((s) => { if (s.colour) m[s.id] = s.colour; });
    return m;
  }, [staffList]);

  // ── Initial data load ──
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [qt, st, ov, ct, staff, entities] = await Promise.all([
          fetchQuickTasks(),
          fetchScheduledTasks(),
          fetchInstanceOverrides(),
          fetchCompletedTasks(),
          fetchStaffProfiles(),
          fetchEntities(),
        ]);
        if (cancelled) return;
        setQuickTasks(qt);
        setScheduledTasks(st);
        setOverrides(ov);
        setCompletedTasks(ct);
        setStaffList(staff);
        setEntityList(entities);

        // Load progress notes for active tasks
        const quickIds = qt.map((t) => t.id);
        const schedIds = st.map((t) => t.id);
        const [qNotes, sNotes] = await Promise.all([
          quickIds.length ? fetchProgressNotes('quick', quickIds) : [],
          schedIds.length ? fetchProgressNotes('scheduled', schedIds) : [],
        ]);
        if (!cancelled) setProgressNotes([...qNotes, ...sNotes]);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load data');
      }
      if (!cancelled) setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ── Process overdue tasks on mount ──
  // Runs once after data loads. Moves 2+ working-day-overdue tasks to unplanned.
  const overdueProcessed = useRef(false);
  useEffect(() => {
    if (loading || overdueProcessed.current) return;
    overdueProcessed.current = true;
    const now = today();

    // Process quick tasks
    quickTasks.forEach(async (t) => {
      if (!t.planned_date) return;
      const planned = new Date(t.planned_date);
      planned.setHours(0, 0, 0, 0);
      if (planned >= now) return; // not past yet
      const assignee = staffList.find((s) => s.id === t.assignee_id);
      const wd = assignee?.working_days || 'mon,tue,wed,thu,fri';
      const overdueDays = countWorkingDaysSince(planned, now, wd);
      if (overdueDays >= 2) {
        try {
          await updateQuickTaskDb(t.id, { planned_date: null });
          setQuickTasks((prev) => prev.map((qt) =>
            qt.id === t.id ? { ...qt, planned_date: null, _overdue: 'late' } : qt
          ));
        } catch { /* silent */ }
      } else if (overdueDays === 1) {
        setQuickTasks((prev) => prev.map((qt) =>
          qt.id === t.id ? { ...qt, _overdue: 'warning' } : qt
        ));
      }
    });

    // Process non-recurring scheduled tasks
    scheduledTasks.forEach(async (m) => {
      if (!m.planned_date || m.recurring) return;
      const planned = new Date(m.planned_date);
      planned.setHours(0, 0, 0, 0);
      if (planned >= now) return;
      // Check if completed
      const key = `${m.id}_${formatISO(planned)}`;
      if (completedTasks.some((c) => c.source_id === m.id && c.occurrence_date === formatISO(planned))) return;
      const assignee = staffList.find((s) => s.id === m.assignee_id);
      const wd = assignee?.working_days || 'mon,tue,wed,thu,fri';
      const overdueDays = countWorkingDaysSince(planned, now, wd);
      if (overdueDays >= 2) {
        try {
          await updateScheduledTaskDb(m.id, { planned_date: null, planned_hour: null, planned_min: null });
          setScheduledTasks((prev) => prev.map((st) =>
            st.id === m.id ? { ...st, planned_date: null, planned_hour: null, planned_min: null, _overdue: 'late' } : st
          ));
        } catch { /* silent */ }
      }
    });
  }, [loading]);

  // ── Real-time subscriptions ──
  useEffect(() => {
    const unsubscribe = subscribeToWorkPlanner({
      onQuickTasks: (payload) => {
        if (payload.eventType === 'INSERT') {
          setQuickTasks((prev) => {
            if (prev.some((t) => t.id === payload.new.id)) return prev;
            return [...prev, payload.new].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
          });
        } else if (payload.eventType === 'UPDATE') {
          setQuickTasks((prev) => prev.map((t) => t.id === payload.new.id ? payload.new : t));
        } else if (payload.eventType === 'DELETE') {
          setQuickTasks((prev) => prev.filter((t) => t.id !== payload.old.id));
        }
      },
      onScheduledTasks: (payload) => {
        if (payload.eventType === 'INSERT') {
          setScheduledTasks((prev) => {
            if (prev.some((t) => t.id === payload.new.id)) return prev;
            return [...prev, payload.new];
          });
        } else if (payload.eventType === 'UPDATE') {
          setScheduledTasks((prev) => prev.map((t) => t.id === payload.new.id ? payload.new : t));
        } else if (payload.eventType === 'DELETE') {
          setScheduledTasks((prev) => prev.filter((t) => t.id !== payload.old.id));
        }
      },
      onOverrides: (payload) => {
        if (payload.eventType === 'INSERT') {
          setOverrides((prev) => {
            if (prev.some((o) => o.id === payload.new.id)) return prev;
            return [...prev, payload.new];
          });
        } else if (payload.eventType === 'UPDATE') {
          setOverrides((prev) => prev.map((o) => o.id === payload.new.id ? payload.new : o));
        } else if (payload.eventType === 'DELETE') {
          setOverrides((prev) => prev.filter((o) => o.id !== payload.old.id));
        }
      },
      onCompleted: (payload) => {
        if (payload.eventType === 'INSERT') {
          setCompletedTasks((prev) => {
            if (prev.some((c) => c.id === payload.new.id)) return prev;
            return [payload.new, ...prev];
          });
        }
      },
      onProgressNote: (payload) => {
        if (payload.eventType === 'INSERT') {
          setProgressNotes((prev) => {
            if (prev.some((n) => n.id === payload.new.id)) return prev;
            return [...prev, payload.new];
          });
        }
      },
    });

    return unsubscribe;
  }, []);

  // ── Actions ──

  // Opens the NewClientModal and returns a promise that resolves with the new entity
  const addEntity = useCallback((name) => {
    return new Promise((resolve) => {
      setNewClientModal({ open: true, initialName: name, resolve });
    });
  }, []);

  const handleNewClientSave = useCallback(async (fields) => {
    // Pass full fields object — insertEntity sends name, type, status, source, prospect_email
    const data = await insertEntity(fields);
    setEntityList((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
    // Resolve the promise so the ClientTypeAhead selects the new entity
    if (newClientModal.resolve) newClientModal.resolve(data);
    return data;
  }, [newClientModal.resolve]);

  const handleNewClientClose = useCallback(() => {
    // Resolve with null so the ClientTypeAhead doesn't hang
    if (newClientModal.resolve) newClientModal.resolve(null);
    setNewClientModal({ open: false, initialName: '', resolve: null });
  }, [newClientModal.resolve]);

  const addQuickTask = useCallback(async (task) => {
    const data = await insertQuickTask(task);
    // Real-time will handle state update, but set optimistically too
    setQuickTasks((prev) => [data, ...prev]);
  }, []);

  const updateQuickTask = useCallback(async (id, patch) => {
    setQuickTasks((prev) => prev.map((t) => t.id === id ? { ...t, ...patch } : t));
    await updateQuickTaskDb(id, patch);
  }, []);

  const reorderQuickTasks = useCallback(async (ids) => {
    // Optimistic: reorder in state
    setQuickTasks((prev) => {
      const map = {};
      prev.forEach((t) => { map[t.id] = t; });
      return ids.filter((id) => map[id]).map((id, i) => ({ ...map[id], sort_order: i }));
    });
    await reorderQuickTasksDb(ids);
  }, []);

  const addScheduledTask = useCallback(async (task) => {
    const data = await insertScheduledTask({
      ...task,
      created_by: profile.id,
    });
    setScheduledTasks((prev) => [data, ...prev]);
    return data;
  }, [profile]);

  const updateScheduledTask = useCallback(async (id, patch) => {
    setScheduledTasks((prev) => prev.map((t) => t.id === id ? { ...t, ...patch } : t));
    await updateScheduledTaskDb(id, patch);
  }, []);

  const deleteScheduledTask = useCallback(async (id) => {
    setScheduledTasks((prev) => prev.filter((t) => t.id !== id));
    setOverrides((prev) => prev.filter((o) => o.master_id !== id));
    await deleteScheduledTaskDb(id);
  }, []);

  const saveOverride = useCallback(async (masterId, date, fields) => {
    const dateStr = date instanceof Date ? formatISO(date) : formatISO(new Date(date));
    const key = instanceKey(masterId, dateStr);

    // Optimistic update
    setOverrides((prev) => {
      const existing = prev.find((o) => o.master_id === masterId && o.occurrence_date === dateStr);
      if (existing) {
        return prev.map((o) =>
          o.master_id === masterId && o.occurrence_date === dateStr
            ? { ...o, ...fields } : o
        );
      }
      return [...prev, { id: 'temp_' + key, master_id: masterId, occurrence_date: dateStr, ...fields }];
    });

    const data = await upsertInstanceOverride(masterId, dateStr, fields);
    // Replace temp with real
    setOverrides((prev) => prev.map((o) =>
      (o.id === ('temp_' + key) || (o.master_id === masterId && o.occurrence_date === dateStr))
        ? data : o
    ));
  }, []);

  const deleteOverride = useCallback(async (masterId, dateStr) => {
    setOverrides((prev) => prev.filter((o) =>
      !(o.master_id === masterId && o.occurrence_date === dateStr)
    ));
    await deleteInstanceOverride(masterId, dateStr);
  }, []);

  const completeTask = useCallback(async (task, mins) => {
    const isQuick = !!task._isQuick || !!task.due_date;

    const entry = {
      source_type: isQuick ? 'quick' : 'scheduled_instance',
      source_id: isQuick ? task.id : task._masterId,
      occurrence_date: task._date ? formatISO(task._date) : null,
      title: task.title,
      entity_id: task.entity_id || null,
      service: task.service || null,
      assignee_id: task.assignee_id || null,
      completed_by: profile.id,
      completion_mins: mins,
      not_required: false,
    };

    await insertCompletedTask(entry);

    if (isQuick) {
      setQuickTasks((prev) => prev.filter((t) => t.id !== task.id));
      await deleteQuickTaskDb(task.id);
    } else if (task._instance && task._date) {
      // Delete override if exists
      const dateStr = formatISO(task._date);
      const hasOverride = overrides.some(
        (o) => o.master_id === task._masterId && o.occurrence_date === dateStr
      );
      if (hasOverride) {
        await deleteInstanceOverride(task._masterId, dateStr);
        setOverrides((prev) => prev.filter((o) =>
          !(o.master_id === task._masterId && o.occurrence_date === dateStr)
        ));
      }
    }

    setPopover(null);
    setHighlightId(null);
  }, [profile, overrides]);

  const markNotRequired = useCallback(async (task) => {
    const isQuick = !!task._isQuick || !!task.due_date;

    const entry = {
      source_type: isQuick ? 'quick' : 'scheduled_instance',
      source_id: isQuick ? task.id : task._masterId,
      occurrence_date: task._date ? formatISO(task._date) : null,
      title: task.title,
      entity_id: task.entity_id || null,
      service: task.service || null,
      assignee_id: task.assignee_id || null,
      completed_by: profile.id,
      completion_mins: null,
      not_required: true,
    };

    await insertCompletedTask(entry);

    if (isQuick) {
      setQuickTasks((prev) => prev.filter((t) => t.id !== task.id));
      await deleteQuickTaskDb(task.id);
    }

    setPopover(null);
    setHighlightId(null);
  }, [profile]);

  // ── Progress notes ──

  const addProgressNote = useCallback(async (taskType, taskId, noteText, occurrenceDate) => {
    const note = {
      task_type: taskType,
      task_id: taskId,
      note: noteText,
      created_by: profile.id,
      created_by_name: profile.name || profile.email,
      is_completion: false,
      occurrence_date: occurrenceDate || null,
    };
    const saved = await insertProgressNote(note);
    setProgressNotes((prev) => [...prev, saved]);
    return saved;
  }, [profile]);

  // ── Completion modal flow ──

  function handleStartComplete(task) {
    const enriched = { ...task };
    if (task.entity_id && entityMap[task.entity_id]) {
      enriched._entityName = entityMap[task.entity_id].name;
    }
    setPopover(null);
    setCompleteModal({ task: enriched, mode: 'complete' });
  }

  function handleStartNotReq(task) {
    const enriched = { ...task };
    if (task.entity_id && entityMap[task.entity_id]) {
      enriched._entityName = entityMap[task.entity_id].name;
    }
    setPopover(null);
    setCompleteModal({ task: enriched, mode: 'not_required' });
  }

  async function handleConfirmComplete(task, mins, noteText) {
    const isNotReq = mins === null;

    if (noteText) {
      const taskType = (!!task._isQuick || !!task.due_date) ? 'quick' : 'scheduled';
      const taskId = (!!task._isQuick || !!task.due_date) ? task.id : task._masterId;
      const occDate = task._date ? formatISO(task._date) : null;
      await insertProgressNote({
        task_type: taskType,
        task_id: taskId,
        note: noteText,
        created_by: profile.id,
        created_by_name: profile.name || profile.email,
        is_completion: true,
        occurrence_date: occDate,
      });
    }

    if (isNotReq) {
      await markNotRequired(task);
    } else {
      await completeTask(task, mins);
    }

    setCompleteModal(null);
  }

  // ── Event handlers ──

  function handleAction(e, task) {
    if (task._promote) {
      handlePromote(task);
      return;
    }
    if (e) {
      const rect = e.target.getBoundingClientRect();
      setHighlightId(task.id);
      setPopover({
        x: Math.min(rect.left, window.innerWidth - 200),
        y: Math.min(rect.bottom + 2, window.innerHeight - 60),
        task,
      });
    }
  }

  function handleOpen(task) {
    if (task._instance) {
      setInstanceModal(task);
      setPopover(null);
    } else if (task._isQuick || task.due_date != null) {
      setQuickModal(task);
      setPopover(null);
    } else {
      setModal(task);
      setPopover(null);
    }
  }

  async function handlePromote(qt) {
    const newMaster = {
      title: qt.title,
      task_type: qt.entity_id ? 'client_work' : 'admin',
      entity_id: qt.entity_id || null,
      service: qt.service || 'Admin',
      assignee_id: qt.assignee_id || null,
      recurring: false,
      recurrence: null,
      status: 'not_started',
      source: 'manual',
      planned_date: qt.planned_date || null,
      planned_hour: null,
      planned_min: null,
      duration: defaultDuration(qt.service, 'manual'),
    };

    // Delete quick task
    setQuickTasks((prev) => prev.filter((t) => t.id !== qt.id));
    await deleteQuickTaskDb(qt.id);

    // Create scheduled task
    const created = await addScheduledTask(newMaster);
    setModal(created);
  }

  async function handleSaveMaster(formData) {
    if (formData.id && scheduledTasks.some((t) => t.id === formData.id)) {
      // Update existing
      const { id, created_at, created_by, ...patch } = formData;
      await updateScheduledTask(id, patch);
    } else {
      // Create new
      const { id, ...rest } = formData;
      await addScheduledTask(rest);
    }
    setModal(null);
  }

  async function handleDeleteMaster(id) {
    await deleteScheduledTask(id);
    setModal(null);
  }

  async function handleSaveOverride(key, overrideData) {
    if (!overrideData) {
      // No changes — just close
      setInstanceModal(null);
      return;
    }
    const parts = key.split('_');
    const dateStr = parts.pop();
    const masterId = parts.join('_');
    await saveOverride(masterId, dateStr, overrideData);
    setInstanceModal(null);
  }

  async function handleResetOverride(instance) {
    await deleteOverride(instance._masterId, formatISO(instance._date));
    setInstanceModal(null);
  }

  // Calendar navigation
  function calNav(dir) {
    setAnchor((prev) => {
      const d = new Date(prev);
      if (calendarView === 'month') d.setMonth(d.getMonth() + dir);
      else if (calendarView === 'day') d.setDate(d.getDate() + dir);
      else if (calendarView === '3day') d.setDate(d.getDate() + dir * 3);
      else d.setDate(d.getDate() + dir * 7);
      return d;
    });
  }

  function calTitle() {
    if (calendarView === 'month') return anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    if (calendarView === 'day') return anchor.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const cv = CALENDAR_VIEWS.find((v) => v.id === calendarView);
    const s = (calendarView === '3day') ? anchor : startOfWeek(anchor);
    const end = addDays(s, (cv ? cv.days : 7) - 1);
    return `${s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} \u2014 ${end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  }

  // Auto-set team filter to current user on My Tasks tab
  useEffect(() => {
    if (activeTab === 'mytasks' && !teamFilter && profile?.id) {
      setTeamFilter(profile.id);
    }
  }, [activeTab, profile]);

  // Clear highlight when popover closes
  useEffect(() => {
    if (!popover) setHighlightId(null);
  }, [popover]);

  // Escape key closes modals/popovers
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') {
        if (popover) { setPopover(null); return; }
        if (completeModal) { setCompleteModal(null); return; }
        if (quickModal) { setQuickModal(null); return; }
        if (instanceModal) { setInstanceModal(null); return; }
        if (modal) { setModal(null); return; }
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [popover, instanceModal, modal]);

  // ── Derived: notes grouped by task key ──
  // For quick tasks: key = "quick:{taskId}"
  // For scheduled instances: key = "scheduled:{masterId}:{occurrenceDate}" or "scheduled:{masterId}" (notes without date)
  // For master-level lookups (all notes on a master): key = "master:{masterId}"
  const notesMap = useMemo(() => {
    const map = {};
    progressNotes.forEach((n) => {
      // Instance-specific key (with occurrence_date)
      const instKey = n.occurrence_date
        ? `${n.task_type}:${n.task_id}:${n.occurrence_date}`
        : `${n.task_type}:${n.task_id}`;
      if (!map[instKey]) map[instKey] = [];
      map[instKey].push(n);

      // Also index under master key for master-level views
      if (n.task_type === 'scheduled') {
        const masterKey = `master:${n.task_id}`;
        if (!map[masterKey]) map[masterKey] = [];
        map[masterKey].push(n);
      }
    });
    return map;
  }, [progressNotes]);

  // ── Context value ──
  const contextValue = useMemo(() => ({
    quickTasks, scheduledTasks, overrides, completedTasks,
    overridesMap, completedKeys,
    staffList, entityList, staffMap, entityMap,
    profile,
    filters: { teamFilter, clientFilter, serviceFilter, statusFilter, sourceFilter },
    highlightId,
    progressNotes, notesMap, addProgressNote,
    addQuickTask, updateQuickTask, reorderQuickTasks,
    addScheduledTask, updateScheduledTask, deleteScheduledTask,
    saveOverride, deleteOverride,
    completeTask, markNotRequired, addEntity,
    colourMode, staffColours, statusColours,
  }), [
    quickTasks, scheduledTasks, overrides, completedTasks,
    overridesMap, completedKeys,
    staffList, entityList, staffMap, entityMap,
    profile,
    teamFilter, clientFilter, serviceFilter, statusFilter, sourceFilter,
    highlightId,
    progressNotes, notesMap, addProgressNote,
    addQuickTask, updateQuickTask, reorderQuickTasks,
    addScheduledTask, updateScheduledTask, deleteScheduledTask,
    saveOverride, deleteOverride,
    completeTask, markNotRequired, addEntity,
    colourMode, staffColours, statusColours,
  ]);

  // ── Loading / Error ──
  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', fontFamily: "'Outfit', sans-serif", color: '#94a3b8', fontSize: 14,
      }}>
        Loading Work Planner...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', fontFamily: "'Outfit', sans-serif", color: '#dc2626', fontSize: 14,
      }}>
        Error: {error}
      </div>
    );
  }

  // ── Render ──
  const showNewBtn = activeTab === 'sched' || activeTab === 'calendar' || activeTab === 'kanban' || activeTab === 'mytasks';

  return (
    <WorkPlannerContext.Provider value={contextValue}>
      <div style={{
        display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
        fontFamily: "'Outfit', sans-serif",
      }}>
        {/* Tab bar */}
        <div style={{
          display: 'flex', background: '#fff', borderBottom: '1px solid #e5e7eb',
          padding: '0 20px', alignItems: 'center',
        }}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => navigate(tab.path)}
              style={{
                padding: '10px 18px', fontSize: 14, fontWeight: 500,
                color: activeTab === tab.id ? '#0e7fe0' : '#64748b',
                cursor: 'pointer', border: 'none', background: 'none',
                borderBottom: activeTab === tab.id ? '2px solid #0e7fe0' : '2px solid transparent',
                fontFamily: "'Outfit', sans-serif",
                transition: 'all 0.15s',
              }}
            >
              {tab.label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {showNewBtn && (
            <div style={{ display: 'flex', gap: 6 }}>
              {activeTab === 'mytasks' && (
                <button
                  onClick={() => setQuickModal({ _new: true })}
                  style={{
                    padding: '5px 12px', fontSize: 11, fontWeight: 500,
                    fontFamily: "'Outfit', sans-serif", border: '1px solid #38bdf8',
                    borderRadius: 8, background: '#dbeafe', color: '#0e7fe0', cursor: 'pointer',
                  }}
                >
                  + Quick Task
                </button>
              )}
              <button
                onClick={() => setModal('new')}
                style={{
                  padding: '5px 12px', fontSize: 11, fontWeight: 500,
                  fontFamily: "'Outfit', sans-serif", border: '1px solid #0f172a',
                  borderRadius: 8, background: '#0f172a', color: '#fff', cursor: 'pointer',
                }}
              >
                + Scheduled Task
              </button>
            </div>
          )}
        </div>

        {/* Filter bar */}
        <FilterBar
          staffList={staffList}
          entityList={entityList}
          teamFilter={teamFilter} setTeamFilter={setTeamFilter}
          clientFilter={clientFilter} setClientFilter={setClientFilter}
          serviceFilter={serviceFilter} setServiceFilter={setServiceFilter}
          statusFilter={statusFilter} setStatusFilter={setStatusFilter}
          view={activeTab}
          calendarView={calendarView} setCalendarView={setCalendarView}
          calTitle={calTitle()} onCalNav={calNav} onCalToday={() => setAnchor(new Date(today()))}
          dueFilter={dueFilter} setDueFilter={setDueFilter}
          sourceFilter={sourceFilter} setSourceFilter={setSourceFilter}
          compact={compact} setCompact={setCompact}
          sort={sort} setSort={setSort}
          colourMode={colourMode} setColourMode={setColourMode}
          staffColours={staffColours}
        />

        {/* Active view */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {activeTab === 'mytasks' && (
            <MyTasksView dueFilter={dueFilter} onAction={handleAction} />
          )}
          {activeTab === 'quick' && (
            <QuickTasksView compact={compact} onAction={handleAction} />
          )}
          {activeTab === 'sched' && (
            <ScheduledView sort={sort} onEdit={(m) => setModal(m)} />
          )}
          {activeTab === 'calendar' && (
            <CalendarView calendarView={calendarView} anchor={anchor} onAction={handleAction} />
          )}
          {activeTab === 'kanban' && (
            <KanbanView dueFilter={dueFilter} onAction={handleAction} />
          )}
          {activeTab === 'completed' && (
            <CompletedView />
          )}
        </div>
      </div>

      {/* Master Modal */}
      {modal != null && (
        <MasterModal
          master={modal === 'new' ? null : modal}
          overridesMap={overridesMap}
          staffList={staffList}
          entityList={entityList}
          progressNotes={modal !== 'new' && modal?.id ? (notesMap[`master:${modal.id}`] || []) : []}
          onSave={handleSaveMaster}
          onDelete={handleDeleteMaster}
          onAddEntity={addEntity}
          onClose={() => setModal(null)}
        />
      )}

      {/* Instance Modal */}
      {instanceModal != null && (
        <InstanceModal
          instance={instanceModal}
          master={scheduledTasks.find((m) => m.id === instanceModal._masterId)}
          staffList={staffList}
          progressNotes={instanceModal._date
            ? (notesMap[`scheduled:${instanceModal._masterId}:${formatISO(instanceModal._date)}`] || [])
            : []}
          onSave={handleSaveOverride}
          onReset={handleResetOverride}
          onClose={() => setInstanceModal(null)}
        />
      )}

      {/* Quick Task Modal */}
      {quickModal != null && (
        <QuickTaskModal
          task={quickModal}
          staffList={staffList}
          entityList={entityList}
          progressNotes={quickModal?.id ? (notesMap[`quick:${quickModal.id}`] || []) : []}
          onSave={async (id, patch) => {
            if (id) {
              await updateQuickTask(id, patch);
            } else {
              await addQuickTask({ ...patch, sort_order: 0, created_by: profile.id });
            }
            setQuickModal(null);
          }}
          onDelete={async (id) => {
            setQuickTasks((prev) => prev.filter((t) => t.id !== id));
            await deleteQuickTaskDb(id);
            setQuickModal(null);
          }}
          onAddEntity={addEntity}
          onClose={() => setQuickModal(null)}
        />
      )}

      {/* Action Popover */}
      {popover != null && (
        <ActionPopover
          x={popover.x}
          y={popover.y}
          task={popover.task}
          onClose={() => setPopover(null)}
          onOpen={handleOpen}
          onStartComplete={handleStartComplete}
          onStartNotReq={handleStartNotReq}
          onDelete={async (task) => {
            try {
              const isQuick = !!task._isQuick || task.due_date != null;
              if (isQuick) {
                setQuickTasks((prev) => prev.filter((t) => t.id !== task.id));
                await deleteQuickTaskDb(task.id);
              } else if (task._instance) {
                await deleteScheduledTask(task._masterId);
              } else {
                await deleteScheduledTask(task.id);
              }
            } catch (e) {
              console.error('[WorkPlanner] delete failed:', e);
              alert('Delete failed: ' + (e.message || 'Unknown error'));
              // Re-fetch to restore state if optimistic update removed it
              try {
                const qt = await fetchQuickTasks();
                setQuickTasks(qt);
              } catch {}
            }
            setPopover(null);
            setHighlightId(null);
          }}
        />
      )}

      {/* Complete Modal */}
      {completeModal != null && (
        <CompleteModal
          task={completeModal.task}
          mode={completeModal.mode}
          onConfirm={handleConfirmComplete}
          onClose={() => setCompleteModal(null)}
        />
      )}

      {/* New Client Modal */}
      <NewClientModal
        open={newClientModal.open}
        initialName={newClientModal.initialName}
        onSave={handleNewClientSave}
        onClose={handleNewClientClose}
      />
    </WorkPlannerContext.Provider>
  );
}
