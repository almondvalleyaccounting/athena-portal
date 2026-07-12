import React, { useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, Plus, Settings2, X } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import {
  addHandoverArea, addNote, initHandovers, listHandoverDefaults,
  removeHandover, saveHandoverDefault, updateHandover,
} from '../api';

const font = "'Outfit', sans-serif";
const input = {
  padding: '5px 8px', fontSize: 12, fontFamily: font, background: '#fff',
  border: '1px solid #cbd5e1', borderRadius: 7,
};

/*
  Per-service-area handovers. Each area (Admin & onboarding / Bookkeeping /
  Accounts / Payroll by default — customisable) has its own owner who settles
  the client in, then hands to a permanent team member. Rows are created
  lazily from onboarding_handover_defaults, filtered by the client's services
  (a non-payroll client gets no Payroll handover).
*/
export default function HandoverPanel({ ob, staff, onChanged }) {
  const { profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newArea, setNewArea] = useState('');
  const [showDefaults, setShowDefaults] = useState(false);
  const initialised = useRef(false);

  const handovers = ob.handovers || [];
  const staffName = (id) => staff.find((s) => s.id === id)?.name || null;
  const dueNow = (h) => h.due && !h.done_at && new Date(h.due) <= new Date();
  const anyDue = handovers.some(dueNow);
  const allDone = handovers.length > 0 && handovers.every((h) => h.done_at);

  // First visit on an onboarding with no handover rows: instantiate from the
  // team defaults (service-aware). Runs once per mount.
  useEffect(() => {
    if (initialised.current || !ob?.id) return;
    initialised.current = true;
    if (handovers.length === 0) {
      initHandovers(ob).then((n) => { if (n > 0) onChanged?.(); }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ob?.id]);

  async function run(fn) {
    setBusy(true); setMsg(null);
    try { await fn(); onChanged?.(); }
    catch (e) { setMsg(e.message); }
    setBusy(false);
  }

  function complete(h) {
    const to = staffName(h.handover_to);
    run(async () => {
      await updateHandover(h.id, { done_at: new Date().toISOString() });
      await addNote(ob.id,
        `Handover complete — ${h.area}: ${to || 'permanent team member'} takes over from ${staffName(h.owner_id) || 'the area owner'}.`,
        { actorId: profile?.id });
    });
  }

  return (
    <div style={{ background: '#fff', border: `1px solid ${anyDue ? tones.warning.border : '#e5e7eb'}`, borderRadius: 12, padding: '14px 18px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <ArrowRightLeft size={14} color="#64748b" />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Handovers by service
        </span>
        {allDone && <span style={chipStyle('success')}>all done</span>}
        {anyDue && <span style={chipStyle('warning')}>DUE</span>}
        <button
          onClick={() => setShowDefaults((v) => !v)}
          title="Edit the team defaults used for new onboardings"
          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: showDefaults ? '#0f172a' : '#94a3b8', padding: 2, display: 'flex' }}
        >
          <Settings2 size={14} />
        </button>
      </div>

      <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
        Each area owner settles the client in, then hands them to their permanent team member.
      </div>

      {showDefaults && <DefaultsEditor staff={staff} onClose={() => setShowDefaults(false)} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {handovers.map((h) => (
          <div key={h.id} style={{
            border: `1px solid ${dueNow(h) ? tones.warning.border : '#f1f5f9'}`,
            borderRadius: 9, padding: '8px 10px',
            background: h.done_at ? '#f8fdf9' : dueNow(h) ? tones.warning.bg : '#fbfcfd',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: h.done_at ? 0 : 7 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a', flex: 1 }}>{h.area}</span>
              {h.done_at
                ? <span style={chipStyle('success')}>done {new Date(h.done_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span>
                : dueNow(h) && <span style={chipStyle('warning')}>due</span>}
              {!h.done_at && (
                <button
                  onClick={() => { if (window.confirm(`Remove the "${h.area}" handover?`)) run(() => removeHandover(h.id)); }}
                  title="Remove this area" disabled={busy}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', padding: 2, display: 'flex' }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {h.done_at ? (
              <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>
                {staffName(h.owner_id) || '—'} → <strong>{staffName(h.handover_to) || '—'}</strong>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  style={input} value={h.owner_id || ''} disabled={busy} title="Area owner during onboarding"
                  onChange={(e) => run(() => updateHandover(h.id, { owner_id: e.target.value || null }))}
                >
                  <option value="">Owner…</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <span style={{ color: '#94a3b8', fontSize: 11 }}>→</span>
                <select
                  style={input} value={h.handover_to || ''} disabled={busy} title="Permanent team member"
                  onChange={(e) => run(() => updateHandover(h.id, { handover_to: e.target.value || null }))}
                >
                  <option value="">Hand to…</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input
                  type="date" style={input} value={h.due || ''} disabled={busy}
                  onChange={(e) => run(() => updateHandover(h.id, { due: e.target.value || null }))}
                />
                {h.handover_to && (
                  <button
                    disabled={busy} onClick={() => complete(h)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', fontSize: 11.5, fontWeight: 600, fontFamily: font, background: tones.success.solid, color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer' }}
                  >
                    <CheckCircle2 size={12} /> Done
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {handovers.length === 0 && (
          <div style={{ fontSize: 12, color: '#cbd5e1' }}>Setting up handover areas…</div>
        )}
      </div>

      {adding ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <input
            style={{ ...input, flex: 1 }} placeholder="Area name, e.g. VAT" value={newArea} autoFocus
            onChange={(e) => setNewArea(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && newArea.trim()) { run(() => addHandoverArea(ob.id, newArea, profile?.id)); setAdding(false); setNewArea(''); } }}
          />
          <button
            disabled={!newArea.trim() || busy}
            onClick={() => { run(() => addHandoverArea(ob.id, newArea, profile?.id)); setAdding(false); setNewArea(''); }}
            style={{ padding: '5px 10px', fontSize: 11.5, fontWeight: 600, fontFamily: font, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer' }}
          >
            Add
          </button>
          <button onClick={() => { setAdding(false); setNewArea(''); }} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 11.5, cursor: 'pointer', fontFamily: font }}>Cancel</button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 10, background: 'none', border: 'none', color: '#64748b', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: font, padding: 0 }}
        >
          <Plus size={12} /> Add area
        </button>
      )}

      {msg && <div style={{ fontSize: 12, color: tones.danger.fg, marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

// Edits onboarding_handover_defaults — the practice-wide defaults applied to
// new onboardings (existing onboardings keep their rows).
function DefaultsEditor({ staff, onClose }) {
  const [defaults, setDefaults] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    listHandoverDefaults().then(setDefaults).catch((e) => setErr(e.message));
  }, []);

  async function patch(area, changes) {
    const row = defaults.find((d) => d.area === area);
    const next = { ...row, ...changes };
    setDefaults(defaults.map((d) => (d.area === area ? next : d)));
    try { await saveHandoverDefault(next); } catch (e) { setErr(e.message); }
  }

  return (
    <div style={{ border: '1px dashed #cbd5e1', borderRadius: 9, padding: '10px 12px', marginBottom: 12, background: '#f8fafc' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
          Team defaults (new onboardings)
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 2, display: 'flex' }}>
          <X size={13} />
        </button>
      </div>
      {!defaults && !err && <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</div>}
      {defaults?.map((d) => (
        <div key={d.area} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 0', opacity: d.active ? 1 : 0.5 }}>
          <span style={{ fontSize: 12, color: '#0f172a', fontWeight: 600, flex: 1 }}>{d.area}</span>
          <select
            style={input} value={d.default_owner_id || ''}
            onChange={(e) => patch(d.area, { default_owner_id: e.target.value || null })}
          >
            <option value="">— no default owner —</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input
            type="checkbox" checked={d.active} title="Include this area on new onboardings"
            onChange={(e) => patch(d.area, { active: e.target.checked })}
          />
        </div>
      ))}
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
        Areas with a service condition (Bookkeeping/Accounts/Payroll) only appear when the client
        takes that service. Changes apply to new onboardings.
      </div>
      {err && <div style={{ fontSize: 12, color: tones.danger.fg, marginTop: 6 }}>{err}</div>}
    </div>
  );
}
