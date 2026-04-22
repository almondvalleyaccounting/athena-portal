import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { getSetting, updateSetting } from '../lib/workflowQueries';
import { useAuth } from '../../../shell/AppShell';

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
    </div>
  );
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
  const tones = { red: { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b' } };
  const t = tones[tone] || tones.red;
  return { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 8, background: t.bg, border: `1px solid ${t.border}`, color: t.color, fontSize: 13, marginBottom: 14 };
}
