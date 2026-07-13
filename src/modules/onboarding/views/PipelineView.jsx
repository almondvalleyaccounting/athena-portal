import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus, Clock, AlertTriangle, Hourglass } from 'lucide-react';
import { Btn } from '../../../components/ui';
import { tones, chipStyle, pillStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import ChasersPanel from '../components/ChasersPanel';
import ViewTabs from '../components/ViewTabs';
import { listOnboardings, isOverdue, daysSince, ONBOARDING_STATUSES, setOnboardingStatus, setOnboardingArchived } from '../api';

const font = "'Outfit', sans-serif";

function statusMeta(value) {
  return ONBOARDING_STATUSES.find((s) => s.value === value) || ONBOARDING_STATUSES[0];
}

function actionBtnStyle(tone) {
  const t = tones[tone] || tones.neutral;
  return {
    padding: '6px 12px', fontSize: 12, fontWeight: 600, fontFamily: font,
    background: t.bg, color: t.fg, border: `1px solid ${t.border}`,
    borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
  };
}

function ProgressBar({ done, total }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 999, background: '#e5e7eb', overflow: 'hidden', minWidth: 80 }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: pct === 100 ? tones.success.solid : '#F5C518' }} />
      </div>
      <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>{done}/{total}</span>
    </div>
  );
}

export default function PipelineView() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const isAdmin = profile?.can_manage_portal === true || profile?.is_portal_admin === true;
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('open'); // open | complete | archived | all
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [hoverIssue, setHoverIssue] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listOnboardings()
      .then((data) => { if (!cancelled) setRows(data); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

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
    setBusyId(r.id);
    try {
      let patch;
      if (action === 'complete') {
        await setOnboardingStatus(r.id, 'complete', { actorId: profile?.id, prevStatus: r.status });
        patch = { status: 'complete', completed_at: new Date().toISOString() };
      } else if (action === 'reopen') {
        await setOnboardingStatus(r.id, 'active', { actorId: profile?.id, prevStatus: r.status });
        patch = { status: 'active', completed_at: null };
      } else if (action === 'archive') {
        await setOnboardingArchived(r.id, true, { actorId: profile?.id });
        patch = { archived_at: new Date().toISOString() };
      } else if (action === 'restore') {
        await setOnboardingArchived(r.id, false, { actorId: profile?.id });
        patch = { archived_at: null };
      }
      setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, ...patch } : x)));
    } catch (err) {
      setError(err.message);
    }
    setBusyId(null);
  }

  const summarise = (r) => {
    const steps = r.steps || [];
    const applicable = steps.filter((s) => s.status !== 'na');
    const done = applicable.filter((s) => s.status === 'complete').length;
    const waitingClient = steps.filter((s) => s.status === 'waiting_client').length;
    const waitingExternal = steps.filter((s) => s.status === 'waiting_external').length;
    const overdue = steps.filter(isOverdue).length;
    return { done, total: applicable.length, waitingClient, waitingExternal, overdue };
  };

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Onboarding</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            New clients and new services, from first contact to fully set up
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ViewTabs active="List" />
          <button
            onClick={() => navigate('/onboarding/updates')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: 13, fontWeight: 600, fontFamily: font, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 10, cursor: 'pointer' }}
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
            marginLeft: 'auto', padding: '7px 12px', fontSize: 13, fontFamily: font,
            border: '1px solid #cbd5e1', borderRadius: 8, minWidth: 220, background: '#fff',
          }}
        />
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 13 }}>Failed to load: {error}</div>}
      {!rows && !error && <div style={{ color: '#64748b', fontSize: 13 }}>Loading…</div>}

      {rows && filtered.length === 0 && (
        <div style={{
          background: '#fff', border: '1px dashed #cbd5e1', borderRadius: 12,
          padding: '40px 20px', textAlign: 'center', color: '#64748b', fontSize: 14,
        }}>
          No onboardings here yet. Start one with the gold button.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {filtered.map((r) => {
          const s = summarise(r);
          const meta = statusMeta(r.status);
          const age = daysSince(r.started_at);
          return (
            <div
              key={r.id}
              onClick={() => navigate(`/onboarding/${r.id}`)}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(180px, 2fr) 110px minmax(140px, 1.4fr) minmax(180px, 1.4fr) 90px auto',
                gap: 14, alignItems: 'center',
                background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12,
                padding: '14px 18px', cursor: 'pointer',
                opacity: busyId === r.id ? 0.55 : 1,
              }}
            >
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 600, color: '#0f172a' }}>{r.entity?.name || '—'}</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                  {r.template?.name || '—'} · {r.owner?.name ? `Owner: ${r.owner.name}` : 'No owner'}
                </div>
              </div>
              {r.status === 'issues' ? (
                <span
                  style={{ position: 'relative', justifySelf: 'start' }}
                  onMouseEnter={() => setHoverIssue(r.id)}
                  onMouseLeave={() => setHoverIssue((h) => (h === r.id ? null : h))}
                >
                  <span style={{ ...chipStyle(meta.tone), cursor: 'help' }}>{meta.label}</span>
                  {hoverIssue === r.id && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 20,
                      width: 260, background: '#0f172a', color: '#fff', fontSize: 12, lineHeight: 1.45,
                      padding: '9px 11px', borderRadius: 8, boxShadow: '0 8px 24px rgba(15,23,42,0.28)',
                      whiteSpace: 'normal', fontWeight: 400,
                    }}>
                      {r.issue_note || 'No reason recorded yet — open the client to add one.'}
                    </div>
                  )}
                </span>
              ) : (
                <span style={{ ...chipStyle(meta.tone), justifySelf: 'start' }}>{meta.label}</span>
              )}
              <ProgressBar done={s.done} total={s.total} />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {s.waitingClient > 0 && (
                  <span style={{ ...chipStyle('warning'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Hourglass size={10} /> {s.waitingClient} on client
                  </span>
                )}
                {s.waitingExternal > 0 && (
                  <span style={{ ...chipStyle('accent'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Clock size={10} /> {s.waitingExternal} on HMRC/3rd party
                  </span>
                )}
                {s.overdue > 0 && (
                  <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <AlertTriangle size={10} /> {s.overdue} overdue
                  </span>
                )}
                {r.escalation_status && r.escalation_status !== 'none' && (
                  <span style={chipStyle(r.escalation_status === 'paused' ? 'neutral' : 'danger')}>
                    {r.escalation_status.replace(/_/g, ' ')}
                  </span>
                )}
                {(r.handovers || []).some((h) => h.due && !h.done_at && new Date(h.due) <= new Date()) && (
                  <span style={chipStyle('warning')}>handover due</span>
                )}
                {r.checkin_due && !r.checkin_sent_at && new Date(r.checkin_due) <= new Date() && (
                  <span style={chipStyle('info')}>check-in due</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#64748b', textAlign: 'right' }}>
                {age != null ? `${age}d in` : ''}
                {r.target_date ? <div>due {new Date(r.target_date).toLocaleDateString('en-GB')}</div> : null}
              </div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                {r.archived_at ? (
                  <button disabled={busyId === r.id} onClick={(e) => runAction(r, 'restore', e)} style={actionBtnStyle('info')}>
                    Restore
                  </button>
                ) : (
                  <>
                    {r.status === 'complete' ? (
                      <button disabled={busyId === r.id} onClick={(e) => runAction(r, 'reopen', e)} style={actionBtnStyle('neutral')}>
                        Reopen
                      </button>
                    ) : (
                      <button disabled={busyId === r.id} onClick={(e) => runAction(r, 'complete', e)} style={actionBtnStyle('success')}>
                        Complete
                      </button>
                    )}
                    <button disabled={busyId === r.id} onClick={(e) => runAction(r, 'archive', e)} style={actionBtnStyle('neutral')}>
                      Archive
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
