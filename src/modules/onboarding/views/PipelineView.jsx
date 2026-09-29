import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus, MessageSquare, CheckCircle2, RotateCcw, Archive, Flag } from 'lucide-react';
import { Btn } from '../../../components/ui';
import DataTable from '../../../components/DataTable';
import RowMenu from '../../../components/RowMenu';
import { tones, pillStyle, chipStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import ChasersPanel from '../components/ChasersPanel';
import ViewTabs from '../components/ViewTabs';
import NotesThread from '../components/NotesThread';
import { listOnboardings, setOnboardingStatus, setOnboardingPriority, priorityMeta, ONBOARDING_PRIORITIES, setOnboardingArchived, outstandingSteps, autoCompletedSteps } from '../api';
import { BTN } from '../../../lib/buttonStyles';

const font = "'Outfit', sans-serif";

function actionBtnStyle(tone) {
  const t = tones[tone] || tones.neutral;
  return {
    padding: '6px 12px', fontSize: 13, fontWeight: 600, fontFamily: font,
    background: t.bg, color: t.fg, border: `1px solid ${t.border}`,
    borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
  };
}

// Short labels for the step groups, so each onboarding's progress reads as
// one line of chips. An unknown group shows its own name.
const GROUP_LABELS = {
  Onboarding: 'O/B',
  'Tax Calc': 'TaxCalc',
  'Inform Direct': 'Inform Direct',
  'VAT Registration': 'VAT reg',
  'PAYE Registration': 'PAYE reg',
  'HMRC Registration': 'HMRC reg',
  'Companies House': 'CH',
};

function groupLabel(name) {
  if (GROUP_LABELS[name]) return GROUP_LABELS[name];
  // Additional directors' SA groups are "SA — <name>"
  const m = /^SA — (.+)$/.exec(name || '');
  if (m) return `SA · ${m[1].split(' ')[0]}`;
  return name || 'Other';
}

// Steps grouped by group_name in template order. A group whose every step is
// N/A isn't a service this client has, so it's left out.
function groupSteps(steps) {
  const byName = new Map();
  for (const st of steps || []) {
    const key = st.group_name || 'Other';
    if (!byName.has(key)) byName.set(key, { name: key, sort: st.group_sort ?? 999, steps: [] });
    byName.get(key).steps.push(st);
  }
  return [...byName.values()]
    .map((g) => {
      const applicable = g.steps.filter((s) => s.status !== 'na').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
      return { ...g, applicable, done: applicable.filter((s) => s.status === 'complete').length };
    })
    .filter((g) => g.applicable.length > 0)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

function GroupChip({ group, hovered, onHover }) {
  const { done, applicable } = group;
  const total = applicable.length;
  const full = done === total;
  const pct = Math.round((done / total) * 100);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onHover({ top: rect.bottom + 6, left: Math.min(rect.left, window.innerWidth - 292) });
      }}
      onMouseLeave={() => onHover(null)}
    >
      <span style={{
        display: 'inline-flex', flexDirection: 'column', gap: 4, minWidth: 64,
        padding: '5px 8px', borderRadius: 8, cursor: 'default',
        background: full ? tones.success.bg : '#fff',
        border: `1px solid ${full ? tones.success.border : '#e2e8f0'}`,
      }}>
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 600, color: full ? tones.success.fg : '#0f172a' }}>{groupLabel(group.name)}</span>
          <span style={{ color: full ? tones.success.fg : '#64748b' }}>{done}/{total}</span>
        </span>
        <span style={{ height: 4, borderRadius: 999, background: '#e5e7eb', overflow: 'hidden' }}>
          <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: full ? tones.success.solid : '#F5C518' }} />
        </span>
      </span>
      {hovered && (
        <div style={{
          position: 'fixed', top: hovered.top, left: hovered.left, zIndex: 50,
          width: 280, background: '#0f172a', color: '#fff', fontSize: 13, lineHeight: 1.45,
          padding: '9px 11px', borderRadius: 8, boxShadow: '0 8px 24px rgba(15,23,42,0.28)',
          whiteSpace: 'normal', fontWeight: 400,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{group.name} — {done} of {total} done</div>
          {applicable.map((st) => (
            <div key={st.id} style={{ display: 'flex', gap: 6, color: st.status === 'complete' ? '#fff' : '#94a3b8' }}>
              <span style={{ width: 12, flexShrink: 0 }}>{st.status === 'complete' ? '✓' : '○'}</span>
              <span>{st.name}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

// High priority always on top, whatever the column sort.
const pinByPriority = (r) => priorityMeta(r.priority).rank;

export default function PipelineView() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const isAdmin = profile?.can_manage_portal === true || profile?.is_portal_admin === true;
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('open'); // open | complete | archived | all
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);
  // { key, top, left } — a group chip's step list, pinned to the viewport so
  // the table's clipped cells and rounded frame don't cut it off.
  const [hoverGroup, setHoverGroup] = useState(null);
  const [openNotes, setOpenNotes] = useState(null); // onboarding id whose comments are expanded
  const [sort, setSort] = useState(null); // null = as loaded (newest first)
  const [page, setPage] = useState(1);

  // Back to page 1 when the tab or search changes. Paging is controlled so an
  // action or a new comment (which reloads the rows) never jumps the page.
  const pageKey = `${filter}|${search}`;
  const [pagedFor, setPagedFor] = useState(pageKey);
  if (pagedFor !== pageKey) { setPagedFor(pageKey); setPage(1); }

  useEffect(() => {
    let cancelled = false;
    listOnboardings()
      .then((data) => { if (!cancelled) setRows(data); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

  const reload = () => listOnboardings().then(setRows).catch((e) => setError(e.message));

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      const archived = Boolean(r.archived_at);
      // Archived onboardings live only in the Archived tab; everything else
      // works on live rows.
      if (filter === 'archived' ? !archived : archived) return false;
      if (filter === 'open' && !['active', 'on_hold', 'issues'].includes(r.status)) return false;
      if (filter === 'complete' && r.status !== 'complete') return false;
      if (search && !r.entity?.name?.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [rows, filter, search]);

  async function runAction(r, action, e) {
    e.stopPropagation();

    // Complete closes out the rest of the checklist and Reopen puts it back,
    // so both say what they are about to move before they move it.
    const open = outstandingSteps(r.steps);
    const auto = autoCompletedSteps(r.steps);
    if (action === 'complete' && open.length) {
      const ok = window.confirm(
        `Mark ${r.entity?.name || 'this onboarding'} complete?\n\n`
        + `${open.length} step${open.length === 1 ? '' : 's'} still open will be ticked off. `
        + `Reopen puts them back exactly as they are now.`,
      );
      if (!ok) return;
    }
    if (action === 'reopen' && auto.length) {
      const ok = window.confirm(
        `Reopen ${r.entity?.name || 'this onboarding'}?\n\n`
        + `${auto.length} step${auto.length === 1 ? '' : 's'} ticked off when it was completed will go back to what they were.`,
      );
      if (!ok) return;
    }

    setBusyId(r.id);
    try {
      let patch;
      if (action === 'complete') {
        await setOnboardingStatus(r.id, 'complete', { actorId: profile?.id, prevStatus: r.status });
        const now = new Date().toISOString();
        patch = {
          status: 'complete',
          completed_at: now,
          steps: (r.steps || []).map((st) => (open.some((o) => o.id === st.id)
            ? { ...st, status: 'complete', auto_completed_at: now } : st)),
        };
      } else if (action === 'reopen') {
        await setOnboardingStatus(r.id, 'active', { actorId: profile?.id, prevStatus: r.status });
        patch = { status: 'active', completed_at: null };
      } else if (action.startsWith('priority:')) {
        const priority = action.slice('priority:'.length);
        await setOnboardingPriority(r.id, priority, { actorId: profile?.id, prevPriority: r.priority });
        patch = { priority };
      } else if (action === 'archive') {
        await setOnboardingArchived(r.id, true, { actorId: profile?.id });
        patch = { archived_at: new Date().toISOString() };
      } else if (action === 'restore') {
        await setOnboardingArchived(r.id, false, { actorId: profile?.id });
        patch = { archived_at: null };
      }
      setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, ...patch } : x)));
      // Reopen restores each step to the status it held before completion,
      // which only the server knows — read the row back rather than guess.
      if (action === 'reopen' && auto.length) await reload();
    } catch (err) {
      setError(err.message);
    }
    setBusyId(null);
  }

  const progress = (r) => {
    const applicable = (r.steps || []).filter((st) => st.status !== 'na');
    return applicable.length ? applicable.filter((st) => st.status === 'complete').length / applicable.length : 0;
  };

  const columns = [
    {
      key: 'client', label: 'Client', width: '24%', wrap: true,
      sortValue: (r) => r.entity?.name || null,
      render: (r) => {
        return (
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, color: '#0f172a' }}>
              {r.entity?.name || '—'}
              {r.priority === 'high' && (
                <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Flag size={10} /> High
                </span>
              )}
              {r.priority === 'low' && <span style={chipStyle('neutral')}>Low</span>}
            </div>
          </div>
        );
      },
    },
    {
      key: 'progress', label: 'Progress', wrap: true,
      sortValue: progress,
      render: (r) => (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {groupSteps(r.steps).map((g) => {
            const key = `${r.id}|${g.name}`;
            return (
              <GroupChip
                key={g.name}
                group={g}
                hovered={hoverGroup?.key === key ? hoverGroup : null}
                onHover={(pos) => setHoverGroup(pos ? { key, ...pos } : (h) => (h?.key === key ? null : h))}
              />
            );
          })}
        </div>
      ),
    },
    {
      key: 'actions', label: '', width: 190, align: 'right', sortable: false,
      // One main action per row (UI audit, Sprint 4). The row itself opens the
      // onboarding — the usual next step — so a button only appears when there
      // is a real decision on the row: Complete once every step is done,
      // Restore when archived. The rest is in the ⋮ menu, Archive last in red.
      // Same runAction calls and confirms as before.
      render: (r) => {
        const notes = r.notes || [];
        const notesOpen = openNotes === r.id;
        const busy = busyId === r.id;
        const openCount = outstandingSteps(r.steps).length;
        const noEvent = { stopPropagation() {} };
        const act = (action) => () => { if (!busy) runAction(r, action, noEvent); };
        const menu = r.archived_at ? [] : [
          r.status === 'complete'
            ? { label: 'Reopen…', icon: RotateCcw, onClick: act('reopen') }
            : openCount > 0 && { label: `Mark complete… (${openCount} step${openCount === 1 ? '' : 's'} open)`, icon: CheckCircle2, onClick: act('complete') },
          ...ONBOARDING_PRIORITIES.filter((p) => p.value !== (r.priority || 'normal')).map((p) => ({
            label: `${p.label} priority`, icon: Flag, onClick: act(`priority:${p.value}`),
          })),
          { label: 'Archive', icon: Archive, onClick: act('archive'), danger: true },
        ].filter(Boolean);
        return (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              onClick={(e) => { e.stopPropagation(); setOpenNotes(notesOpen ? null : r.id); }}
              title={notesOpen ? 'Hide comments' : 'Comments'}
              style={{ ...actionBtnStyle(notesOpen ? 'info' : 'neutral'), display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              <MessageSquare size={12} /> {notes.length || ''}
            </button>
            {r.archived_at && (
              <button disabled={busy} onClick={(e) => runAction(r, 'restore', e)} style={{ ...BTN.secondary.sm, whiteSpace: 'nowrap' }}>
                Restore
              </button>
            )}
            {!r.archived_at && r.status !== 'complete' && openCount === 0 && (
              <button disabled={busy} onClick={(e) => runAction(r, 'complete', e)} style={actionBtnStyle('success')}>
                Complete
              </button>
            )}
            <RowMenu items={menu} />
          </div>
        );
      },
    },
  ];

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Onboarding</h1>
          <p style={{ margin: '4px 0 0', fontSize: 14, color: '#64748b' }}>
            New clients and new services, from first contact to fully set up
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ViewTabs active="List" />
          <button
            onClick={() => navigate('/onboarding/updates')}
            style={{ ...BTN.secondary.md, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
          >
            ✨ Latest updates
          </button>
        <Btn onClick={() => navigate('/onboarding/new')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <UserPlus size={15} /> Start onboarding
          </span>
        </Btn>
        </div>
      </div>

      {isAdmin && <ChasersPanel />}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['open', 'Open'], ['complete', 'Complete'], ['all', 'All'], ['archived', 'Archived']].map(([v, label]) => (
          <button key={v} onClick={() => setFilter(v)} style={pillStyle({ tone: 'info', active: filter === v })}>
            {label}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search client…"
          style={{
            marginLeft: 'auto', padding: '7px 12px', fontSize: 14, fontFamily: font,
            border: '1px solid #cbd5e1', borderRadius: 8, minWidth: 220, background: '#fff',
          }}
        />
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 14 }}>Failed to load: {error}</div>}
      {!rows && !error && <div style={{ color: '#64748b', fontSize: 14 }}>Loading…</div>}

      {rows && filtered.length === 0 && (
        <div style={{
          background: '#fff', border: '1px dashed #cbd5e1', borderRadius: 12,
          padding: '40px 20px', textAlign: 'center', color: '#64748b', fontSize: 14.5,
        }}>
          No onboardings here yet. Start one with the gold button.
        </div>
      )}

      {rows && filtered.length > 0 && (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          rowHref={(r) => `/onboarding/${r.id}`}
          onOpen={(href) => navigate(href)}
          rowStyle={(r) => (busyId === r.id ? { opacity: 0.55 } : undefined)}
          pinFirst={pinByPriority}
          sort={sort}
          onSort={(next) => { setSort(next); setPage(1); }}
          page={page}
          onPage={setPage}
          renderExpanded={(r) => (openNotes === r.id ? (
            <NotesThread onboardingId={r.id} notes={r.notes || []} onAdded={reload} maxHeight={260} autoFocus />
          ) : null)}
        />
      )}
    </div>
  );
}
