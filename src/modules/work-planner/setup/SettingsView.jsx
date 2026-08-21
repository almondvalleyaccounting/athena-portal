import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Trash2 } from 'lucide-react';
import {
  getSetting,
  updateSetting,
  countScheduleRows,
  clearScheduleRows,
  listScheduleTaskGroups,
  listScheduleEntities,
} from './queries';
import { useAuth } from '../../../shell/AppShell';
import ClientTypeAhead from '../components/ClientTypeAhead';

const font = "'Outfit', sans-serif";

const FLAG_KEY = 'workflow.auto_schedule_v2';

export default function SettingsView() {
  const { profile } = useAuth();
  const [flag, setFlag] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const canEdit = profile?.is_portal_admin === true;

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await getSetting(FLAG_KEY);
      setFlag(s);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const setMode = async (mode) => {
    const value =
      mode === 'enabled'  ? { enabled: true,  dry_run: false }
    : mode === 'dry_run'  ? { enabled: false, dry_run: true  }
    : /* off */             { enabled: false, dry_run: false };
    setSaving(true);
    setError(null);
    try {
      const updated = await updateSetting(FLAG_KEY, value);
      setFlag(updated);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const current = flag?.setting_value || {};
  const mode = current.enabled ? 'enabled' : current.dry_run ? 'dry_run' : 'off';

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 800 }}>
      <p style={{ fontSize: 13, color: '#475569', marginBottom: 14 }}>
        Workflow auto-scheduling feature flag. Ingest/reconciliation writes to Supabase regardless of this flag — but future behaviours (Outlook push, automated chasers, calendar propagation) check it before running. Flip when you're confident the data is clean.
      </p>

      {error && (
        <div style={banner('red')}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</p>
      ) : !flag ? (
        <p style={{ fontSize: 13, color: '#991b1b' }}>Flag {FLAG_KEY} not found.</p>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20 }}>
          <p style={{ fontSize: 12, color: '#94a3b8', fontFamily: 'monospace', marginBottom: 4 }}>{FLAG_KEY}</p>
          <p style={{ fontSize: 14, color: '#475569', marginBottom: 16 }}>{flag.description || '—'}</p>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <ModeCard
              label="Off"
              description="Feature flag off. Data pipeline still runs; downstream behaviours do not."
              active={mode === 'off'}
              tone="slate"
              disabled={!canEdit || saving}
              onClick={() => setMode('off')}
            />
            <ModeCard
              label="Dry run"
              description="Downstream behaviours compute what they would do and log it, without writing/sending."
              active={mode === 'dry_run'}
              tone="amber"
              disabled={!canEdit || saving}
              onClick={() => setMode('dry_run')}
            />
            <ModeCard
              label="Enabled"
              description="Fully enabled. Future auto-scheduling behaviours will write and send for real."
              active={mode === 'enabled'}
              tone="green"
              disabled={!canEdit || saving}
              onClick={() => setMode('enabled')}
            />
          </div>

          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: '#64748b', fontWeight: 500 }}>
              Raw value
            </summary>
            <pre style={{
              marginTop: 8, padding: 12, background: '#f8fafc',
              border: '1px solid #e5e7eb', borderRadius: 6,
              fontSize: 11, color: '#1e293b', fontFamily: 'monospace',
              overflow: 'auto',
            }}>
{JSON.stringify(current, null, 2)}
            </pre>
          </details>

          {!canEdit && (
            <p style={{ marginTop: 14, fontSize: 12, color: '#92400e' }}>
              Only portal admins can change this flag.
            </p>
          )}
        </div>
      )}

      <DangerZone canEdit={canEdit} />
    </div>
  );
}

function DangerZone({ canEdit }) {
  const [taskGroups, setTaskGroups] = useState([]);
  const [entities, setEntities] = useState([]);
  const [selectedTaskPrefix, setSelectedTaskPrefix] = useState('');
  const [selectedEntityId, setSelectedEntityId] = useState('');
  const [pending, setPending] = useState(null); // { scope, filters, count }
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const reloadOptions = async () => {
    try {
      const [groups, ents] = await Promise.all([listScheduleTaskGroups(), listScheduleEntities()]);
      setTaskGroups(groups);
      setEntities(ents);
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  useEffect(() => {
    reloadOptions();
  }, []);

  const openConfirm = async (scope, filters, label) => {
    setError(null);
    setNotice(null);
    setConfirmText('');
    try {
      const count = await countScheduleRows(filters);
      setPending({ scope, filters, count, label });
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  const runClear = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await clearScheduleRows(pending.filters);
      setNotice(`Cleared ${pending.count} row${pending.count === 1 ? '' : 's'} (${pending.label}).`);
      setPending(null);
      setSelectedTaskPrefix('');
      setSelectedEntityId('');
      await reloadOptions();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectedEntityName = entities.find((e) => e.id === selectedEntityId)?.name;

  return (
    <div style={{
      marginTop: 28,
      background: '#fff',
      border: '1px solid #fecaca',
      borderRadius: 10,
      padding: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <AlertTriangle size={16} style={{ color: '#b91c1c' }} />
        <h3 style={{
          fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 500,
          color: '#991b1b', margin: 0,
        }}>
          Danger zone — clear scheduled tasks
        </h3>
      </div>
      <p style={{ fontSize: 12, color: '#64748b', marginBottom: 16, lineHeight: 1.5 }}>
        Delete rows from <code>bm_task_schedule</code>. Logged time is kept (stored separately on timesheet entries). A re-import will rebuild rows for any BM tasks that still exist upstream.
      </p>

      {notice && (
        <div style={banner('green')}>
          <Check size={14} /> {notice}
        </div>
      )}
      {error && (
        <div style={banner('red')}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <ClearRow
          label="Clear all scheduled tasks"
          description="Removes every row from the schedule."
          disabled={!canEdit || busy}
          action={
            <button
              onClick={() => openConfirm('all', {}, 'all scheduled tasks')}
              disabled={!canEdit || busy}
              style={dangerBtn(!canEdit || busy)}
            >
              <Trash2 size={12} /> Clear all
            </button>
          }
        />

        <ClearRow
          label="Clear by task type"
          description="Removes every scheduled row matching a task-type prefix (e.g. all Confirmation Statements across all months, in one click)."
          disabled={!canEdit || busy}
          action={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                value={selectedTaskPrefix}
                onChange={(e) => setSelectedTaskPrefix(e.target.value)}
                disabled={!canEdit || busy}
                style={selectStyle}
              >
                <option value="">Select task type…</option>
                {taskGroups.map((g) => (
                  <option key={g.prefix} value={g.prefix}>
                    {g.label} — {g.count} row{g.count === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  const g = taskGroups.find((x) => x.prefix === selectedTaskPrefix);
                  openConfirm(
                    'taskType',
                    { taskPrefix: selectedTaskPrefix },
                    `task type "${g?.label || selectedTaskPrefix}"`,
                  );
                }}
                disabled={!canEdit || busy || !selectedTaskPrefix}
                style={dangerBtn(!canEdit || busy || !selectedTaskPrefix)}
              >
                <Trash2 size={12} /> Clear
              </button>
            </div>
          }
        />

        <ClearRow
          label="Clear by client"
          description="Removes all scheduled rows for a given client."
          disabled={!canEdit || busy}
          action={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ minWidth: 220 }}>
                <ClientTypeAhead
                  entityList={entities}
                  value={selectedEntityId}
                  onChange={setSelectedEntityId}
                />
              </div>
              <button
                onClick={() => openConfirm(
                  'client',
                  { entityId: selectedEntityId },
                  `client "${selectedEntityName || selectedEntityId}"`,
                )}
                disabled={!canEdit || busy || !selectedEntityId}
                style={dangerBtn(!canEdit || busy || !selectedEntityId)}
              >
                <Trash2 size={12} /> Clear
              </button>
            </div>
          }
        />
      </div>

      {pending && (
        <ConfirmModal
          pending={pending}
          confirmText={confirmText}
          onConfirmTextChange={setConfirmText}
          onCancel={() => { setPending(null); setConfirmText(''); }}
          onConfirm={runClear}
          busy={busy}
        />
      )}
    </div>
  );
}

function ClearRow({ label, description, action }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
      padding: '12px 14px', background: '#fef2f2', border: '1px solid #fee2e2', borderRadius: 8,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{label}</div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{description}</div>
      </div>
      {action}
    </div>
  );
}

function ConfirmModal({ pending, confirmText, onConfirmTextChange, onCancel, onConfirm, busy }) {
  const required = pending.scope === 'all' ? 'CLEAR' : null;
  const canConfirm = !busy && pending.count > 0 && (required ? confirmText === required : true);

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 10, padding: 22, width: 440,
          fontFamily: font, boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <AlertTriangle size={18} style={{ color: '#b91c1c' }} />
          <h3 style={{ fontSize: 16, fontWeight: 600, color: '#991b1b', margin: 0 }}>Confirm delete</h3>
        </div>
        <p style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.5, marginBottom: 12 }}>
          This will permanently delete <strong>{pending.count}</strong> schedule row{pending.count === 1 ? '' : 's'} for <strong>{pending.label}</strong>. Logged time is not affected.
        </p>
        {pending.count === 0 && (
          <p style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
            Nothing matches — nothing to delete.
          </p>
        )}
        {required && pending.count > 0 && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: '#475569', display: 'block', marginBottom: 4 }}>
              Type <code>{required}</code> to confirm:
            </label>
            <input
              value={confirmText}
              onChange={(e) => onConfirmTextChange(e.target.value)}
              autoFocus
              style={{
                width: '100%', padding: '7px 10px', fontSize: 13, fontFamily: font,
                border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none',
              }}
            />
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} disabled={busy} style={neutralBtn(busy)}>Cancel</button>
          <button onClick={onConfirm} disabled={!canConfirm} style={dangerBtn(!canConfirm)}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

const selectStyle = {
  padding: '6px 10px', fontSize: 12, fontFamily: font,
  border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: '#0f172a', outline: 'none', minWidth: 220,
};

function dangerBtn(disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '6px 12px', fontSize: 12, fontWeight: 600,
    fontFamily: font, border: 'none', borderRadius: 6,
    background: disabled ? '#fca5a5' : '#dc2626', color: '#fff',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1, transition: 'background 0.1s',
  };
}

function neutralBtn(disabled) {
  return {
    padding: '6px 12px', fontSize: 12, fontWeight: 500,
    fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6,
    background: '#fff', color: '#0f172a',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
  };
}

function ModeCard({ label, description, active, tone, disabled, onClick }) {
  const tones = {
    slate: { bg: '#f8fafc', border: '#cbd5e1', active: '#475569' },
    amber: { bg: '#fffbeb', border: '#fcd34d', active: '#d97706' },
    green: { bg: '#ecfdf5', border: '#86efac', active: '#15803d' },
  };
  const t = tones[tone] || tones.slate;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: '1 1 180px',
        minWidth: 180,
        textAlign: 'left',
        padding: 14,
        borderRadius: 10,
        border: `2px solid ${active ? t.active : t.border}`,
        background: active ? t.bg : '#fff',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        fontFamily: font,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        {active && <Check size={14} style={{ color: t.active }} />}
        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{label}</span>
      </div>
      <p style={{ fontSize: 11, color: '#475569', lineHeight: 1.4 }}>{description}</p>
    </button>
  );
}

function banner(tone) {
  const tones = {
    red:   { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b' },
    green: { bg: '#dcfce7', border: '#86efac', color: '#15803d' },
  };
  const t = tones[tone] || tones.red;
  return { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 8, background: t.bg, border: `1px solid ${t.border}`, color: t.color, fontSize: 13, marginBottom: 14 };
}
