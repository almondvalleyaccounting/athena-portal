import React, { useState } from 'react';
import { ClipboardList, Plus, X } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import {
  SERVICE_OPTIONS, REGISTRATION_OPTIONS, CH_TASK_OPTIONS,
  REG_GROUP, REG_GROUP_SORT, CH_GROUP, CH_GROUP_SORT,
  setServiceConditions, addAdHocStep, deleteOnboardingStep,
} from '../api';

const font = "'Outfit', sans-serif";

/*
  Services & registrations. The service selection is the authoritative record
  of what the client takes — it gates the conditional step groups, the
  handover areas (task owners) and the 3-month check-in tiles. Registrations
  and Companies House changes each become a tracked task step in their own
  group so they show in the checklist and count toward progress.
*/
export default function ServicesPanel({ ob, staff, onChanged }) {
  const { profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const conditions = ob.service_conditions || [];
  const steps = ob.steps || [];
  const regStep = (opt) => steps.find((s) => s.group_name === REG_GROUP && s.name === opt.stepName);
  const chSteps = steps.filter((s) => s.group_name === CH_GROUP);
  const staffName = (id) => staff.find((s) => s.id === id)?.name;

  async function run(fn) {
    setBusy(true); setMsg(null);
    try { await fn(); onChanged?.(); }
    catch (e) { setMsg(e.message); }
    setBusy(false);
  }

  function toggleService(key, on) {
    const next = on ? [...conditions, key] : conditions.filter((c) => c !== key);
    run(() => setServiceConditions(ob, next, { actorId: profile?.id }));
  }

  function toggleRegistration(opt, on) {
    if (on) {
      run(() => addAdHocStep(ob, { group: REG_GROUP, groupSort: REG_GROUP_SORT, name: opt.stepName, actorId: profile?.id }));
    } else {
      const step = regStep(opt);
      if (!step) return;
      if (step.status === 'complete') { setMsg('That registration is already marked done — remove it from the checklist instead.'); return; }
      run(() => deleteOnboardingStep(step.id));
    }
  }

  function addChTask(opt) {
    let name = opt.stepName;
    if (opt.key === 'other') {
      const what = window.prompt('Companies House task:');
      if (!what?.trim()) return;
      name = `${opt.stepName}${what.trim()}`;
    }
    run(() => addAdHocStep(ob, { group: CH_GROUP, groupSort: CH_GROUP_SORT, name, actorId: profile?.id }));
  }

  const box = { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: '#334155', cursor: busy ? 'default' : 'pointer' };

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 18px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <ClipboardList size={14} color="#64748b" />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Services &amp; registrations
        </span>
      </div>

      {/* Services taken */}
      <div style={{ fontSize: 11.5, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Services taken</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>
        {SERVICE_OPTIONS.map((opt) => (
          <label key={opt.key} style={box}>
            <input
              type="checkbox" checked={conditions.includes(opt.key)} disabled={busy}
              onChange={(e) => toggleService(opt.key, e.target.checked)}
            />
            {opt.label}
          </label>
        ))}
      </div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>
        Unticking a service marks its outstanding steps N/A and removes its handover &amp; check-in tiles. Completed steps are left as they are.
      </div>

      {/* HMRC registrations */}
      <div style={{ fontSize: 11.5, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>HMRC registrations required</div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
        {REGISTRATION_OPTIONS.map((opt) => {
          const step = regStep(opt);
          return (
            <label key={opt.key} style={box}>
              <input
                type="checkbox" checked={Boolean(step)} disabled={busy}
                onChange={(e) => toggleRegistration(opt, e.target.checked)}
              />
              {opt.label}
              {step && step.status === 'complete' && <span style={chipStyle('success')}>done</span>}
            </label>
          );
        })}
      </div>

      {/* Companies House tasks */}
      <div style={{ fontSize: 11.5, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Companies House tasks</div>
      {chSteps.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
          {chSteps.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#334155' }}>
              <span style={{ flex: 1 }}>{s.name.replace(/^Companies House — /, '')}</span>
              {s.status === 'complete'
                ? <span style={chipStyle('success')}>done</span>
                : s.assignee_id && staffName(s.assignee_id) && <span style={{ fontSize: 11, color: '#94a3b8' }}>{staffName(s.assignee_id)}</span>}
              {s.status !== 'complete' && (
                <button
                  onClick={() => { if (window.confirm('Remove this Companies House task?')) run(() => deleteOnboardingStep(s.id)); }}
                  title="Remove" disabled={busy}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', padding: 2, display: 'flex' }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {CH_TASK_OPTIONS.map((opt) => (
          <button
            key={opt.key} onClick={() => addChTask(opt)} disabled={busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 11.5, fontWeight: 600, fontFamily: font, background: '#fff', color: tones.info.fg, border: `1px solid ${tones.info.border}`, borderRadius: 999, cursor: busy ? 'default' : 'pointer' }}
          >
            <Plus size={11} /> {opt.label}
          </button>
        ))}
      </div>

      {msg && <div style={{ fontSize: 12, color: tones.danger.fg, marginTop: 10 }}>{msg}</div>}
    </div>
  );
}
