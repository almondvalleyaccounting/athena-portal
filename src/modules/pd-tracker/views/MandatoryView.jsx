import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../shell/AppShell';
import {
  loadStaff, loadMandatoryTrainings, loadMandatoryCompletions,
  recordMandatoryCompletion, createMandatoryTraining, mandatoryStatus,
} from '../lib/api';

const font = "'Outfit', sans-serif";

const STATUS_STYLE = {
  valid:   { bg: '#dcfce7', c: '#16a34a' },
  done:    { bg: '#dcfce7', c: '#16a34a' },
  due:     { bg: '#fef3c7', c: '#b45309' },
  overdue: { bg: '#fee2e2', c: '#b91c1c' },
  missing: { bg: '#f1f5f9', c: '#64748b' },
};

function fmt(d) {
  if (!d) return '—';
  const dt = new Date(d + (String(d).length === 10 ? 'T00:00:00Z' : ''));
  return isNaN(dt) ? '—' : dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

// Latest completion per training for a given staff member.
function latestFor(completions, staffId, trainingId) {
  return completions.find((c) => c.staff_id === staffId && c.training_id === trainingId) || null;
}

export default function MandatoryView() {
  const { profile } = useAuth();
  const isAdmin = profile?.can_manage_portal === true || profile?.is_portal_admin === true;

  const [trainings, setTrainings] = useState([]);
  const [completions, setCompletions] = useState([]);
  const [staff, setStaff] = useState([]);
  const [viewStaffId, setViewStaffId] = useState(profile.id);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [recordFor, setRecordFor] = useState(null); // training being recorded
  const [addOpen, setAddOpen] = useState(false);

  async function reload() {
    const [t, c] = await Promise.all([
      loadMandatoryTrainings(),
      loadMandatoryCompletions(isAdmin ? undefined : profile.id),
    ]);
    setTrainings(t);
    setCompletions(c);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (isAdmin) { const s = await loadStaff(); if (!cancelled) setStaff(s); }
        await reload();
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function saveRecord(training, { completed_on, evidence_url, note }) {
    try {
      await recordMandatoryCompletion({
        staff_id: viewStaffId,
        training_id: training.id,
        completed_on: completed_on || todayISO(),
        evidence_url: evidence_url || null,
        note: note || null,
        recorded_by: profile.id,
      });
      setRecordFor(null);
      await reload();
    } catch (e) {
      alert('Could not save: ' + (e.message || e));
    }
  }

  const viewStaffName = useMemo(() => {
    if (viewStaffId === profile.id) return 'you';
    return staff.find((s) => s.id === viewStaffId)?.name || 'staff member';
  }, [viewStaffId, staff, profile.id]);

  if (loading) return <Msg>Loading mandatory training…</Msg>;
  if (error) return <Msg colour="#dc2626">Error: {error}</Msg>;

  return (
    <div style={{ fontFamily: font, padding: '20px 28px 48px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 600, color: '#0f172a' }}>Mandatory training</h2>
        <div style={{ flex: 1 }} />
        {isAdmin && (
          <label style={{ fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6 }}>
            Recording for
            <select value={viewStaffId} onChange={(e) => setViewStaffId(e.target.value)} style={selectStyle}>
              <option value={profile.id}>{profile.name} (you)</option>
              {staff.filter((s) => s.id !== profile.id).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p style={{ fontSize: 13, color: '#64748b', marginTop: 0, marginBottom: 18 }}>
        Record required training as done — {viewStaffName === 'you' ? 'yours' : `for ${viewStaffName}`}. Annual items go “due” 60 days before expiry, then “overdue”.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {trainings.map((t) => {
          const latest = latestFor(completions, viewStaffId, t.id);
          const st = mandatoryStatus(t, latest);
          const ss = STATUS_STYLE[st.key] || STATUS_STYLE.missing;
          return (
            <div key={t.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 200 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{t.name}</div>
                  {t.description && <div style={{ fontSize: 12, color: '#94a3b8' }}>{t.description}</div>}
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 999, background: ss.bg, color: ss.c }}>{st.label}</span>
                <span style={{ fontSize: 12, color: '#64748b' }}>
                  {latest ? `Done ${fmt(latest.completed_on)}` : 'No record yet'}
                  {latest?.expires_on ? ` · expires ${fmt(latest.expires_on)}` : ''}
                </span>
                <div style={{ flex: 1 }} />
                <button onClick={() => setRecordFor(t)} style={btnPrimary}>Record as done</button>
              </div>
              {recordFor?.id === t.id && (
                <RecordForm training={t} onCancel={() => setRecordFor(null)} onSave={(vals) => saveRecord(t, vals)} />
              )}
            </div>
          );
        })}
        {trainings.length === 0 && <Msg>No mandatory trainings defined yet.</Msg>}
      </div>

      {isAdmin && (
        <>
          <div style={{ marginTop: 28, marginBottom: 8, display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#0f172a' }}>Team compliance</h3>
            <div style={{ flex: 1 }} />
            <button onClick={() => setAddOpen((v) => !v)} style={btnSecondary}>{addOpen ? 'Cancel' : '+ Add training'}</button>
          </div>
          {addOpen && <AddTraining onSaved={async () => { setAddOpen(false); await reload(); }} />}
          <TeamMatrix staff={staff} trainings={trainings} completions={completions} />
        </>
      )}
    </div>
  );
}

function RecordForm({ training, onCancel, onSave }) {
  const [completedOn, setCompletedOn] = useState(todayISO());
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginTop: 12, flexWrap: 'wrap' }}>
      <Field label="Completed on"><input type="date" value={completedOn} onChange={(e) => setCompletedOn(e.target.value)} style={inputStyle} /></Field>
      <Field label="Evidence link (optional)" grow><input type="text" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Certificate URL" style={{ ...inputStyle, width: '100%' }} /></Field>
      <Field label="Note (optional)" grow><input type="text" value={note} onChange={(e) => setNote(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
      <button onClick={() => onSave({ completed_on: completedOn, evidence_url: evidence, note })} style={btnPrimary}>Save</button>
      <button onClick={onCancel} style={btnSecondary}>Cancel</button>
    </div>
  );
}

function AddTraining({ onSaved }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [renewal, setRenewal] = useState('12');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createMandatoryTraining({
        name: name.trim(),
        description: desc.trim() || null,
        renewal_months: renewal ? parseInt(renewal, 10) : null,
        display_order: 100,
      });
      onSaved();
    } catch (e) { alert('Could not add: ' + (e.message || e)); }
    finally { setSaving(false); }
  }
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', padding: 12, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GDPR" style={inputStyle} /></Field>
      <Field label="Description" grow><input value={desc} onChange={(e) => setDesc(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
      <Field label="Renew every (months)"><input type="number" min="0" value={renewal} onChange={(e) => setRenewal(e.target.value)} placeholder="blank = one-off" style={{ ...inputStyle, width: 90 }} /></Field>
      <button onClick={save} disabled={saving || !name.trim()} style={btnPrimary}>{saving ? 'Adding…' : 'Add'}</button>
    </div>
  );
}

function TeamMatrix({ staff, trainings, completions }) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead style={{ background: '#f8fafc' }}>
          <tr>
            <th style={thLeft}>Staff</th>
            {trainings.map((t) => <th key={t.id} style={th}>{t.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.id} style={{ borderTop: '1px solid #f1f5f9' }}>
              <td style={{ ...td, fontWeight: 500, color: '#0f172a' }}>{s.name}</td>
              {trainings.map((t) => {
                const latest = latestFor(completions, s.id, t.id);
                const st = mandatoryStatus(t, latest);
                const ss = STATUS_STYLE[st.key] || STATUS_STYLE.missing;
                return (
                  <td key={t.id} style={{ ...td, textAlign: 'center' }}>
                    <span title={latest ? `Done ${fmt(latest.completed_on)}${latest.expires_on ? ', expires ' + fmt(latest.expires_on) : ''}` : 'No record'}
                      style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: ss.bg, color: ss.c }}>
                      {st.label}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, children, grow }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: grow ? 1 : 'initial' }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle = { padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#0f172a', outline: 'none' };
const selectStyle = { padding: '5px 8px', fontSize: 12, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', cursor: 'pointer' };
const btnPrimary = { fontSize: 12, fontWeight: 600, fontFamily: font, cursor: 'pointer', padding: '7px 14px', borderRadius: 8, border: '1px solid #0f172a', background: '#0f172a', color: '#fff', whiteSpace: 'nowrap' };
const btnSecondary = { fontSize: 12, fontWeight: 500, fontFamily: font, cursor: 'pointer', padding: '7px 14px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', whiteSpace: 'nowrap' };
const th = { padding: '8px 10px', textAlign: 'center', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 };
const thLeft = { ...th, textAlign: 'left' };
const td = { padding: '7px 10px', verticalAlign: 'middle' };

function Msg({ children, colour = '#64748b' }) {
  return <div style={{ padding: 28, fontFamily: font, color: colour, fontSize: 14, textAlign: 'center' }}>{children}</div>;
}
