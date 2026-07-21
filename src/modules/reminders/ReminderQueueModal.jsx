import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';

/*
  Reminder queue — the human review step. Lists reminder_emails rows in
  'queued' status (rendered + stored by reminders-send mode:'queue' but
  NOT sent). A manager reviews each, drops any that shouldn't go, then
  releases the rest — reminders-send mode:'release' sends the STORED body,
  so what was reviewed is exactly what goes out.

  Props: commType, entityById, profile, onClose, onChanged
*/

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };
const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 210,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};
const btnGhost = {
  padding: '7px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: '#fff', color: '#334155', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer',
};
const btnPrimary = (on) => ({
  padding: '8px 16px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: on ? '#0e7fe0' : '#e5e7eb', color: on ? '#fff' : '#94a3b8',
  border: 'none', borderRadius: 8, cursor: on ? 'pointer' : 'default',
});
const btnDanger = (on) => ({
  padding: '7px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: '#fff', color: on ? '#b91c1c' : '#cbd5e1', border: `1px solid ${on ? '#fecaca' : '#e5e7eb'}`,
  borderRadius: 8, cursor: on ? 'pointer' : 'default',
});
const th = {
  padding: '7px 10px', fontSize: 11, fontWeight: 600, color: '#64748b', textAlign: 'left',
  textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const td = { padding: '6px 10px', fontSize: 12.5, color: '#1e293b', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' };

export default function ReminderQueueModal({ commType = 'tax_reminders', entityById = {}, profile, onClose, onChanged }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [focusId, setFocusId] = useState(null);
  const canManage = profile?.can_manage_portal === true || profile?.is_portal_admin === true;

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: e } = await supabase
      .from('reminder_emails')
      .select('id, kind, entity_id, to_email, subject, body_html, queued_at')
      .eq('comm_type', commType).eq('status', 'queued')
      .order('queued_at', { ascending: true });
    if (e) { setError(`Could not load the queue: ${e.message}`); setLoading(false); return; }
    setRows(data || []);
    setSelected(new Set((data || []).map((r) => r.id)));
    setFocusId((cur) => cur || (data && data[0] ? data[0].id : null));
    setLoading(false);
  }, [commType]);

  useEffect(() => { load(); }, [load]);

  const nameOf = (r) => (r.entity_id && entityById[r.entity_id]?.name) || '(unmatched)';
  const focus = useMemo(() => rows.find((r) => r.id === focusId) || null, [rows, focusId]);

  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSel = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSel ? new Set() : new Set(rows.map((r) => r.id)));

  const drop = async () => {
    if (!canManage || !selected.size) return;
    if (!window.confirm(`Drop ${selected.size} queued email${selected.size === 1 ? '' : 's'}? They won't be sent.`)) return;
    setBusy(true); setError(null);
    const ids = [...selected];
    const { error: e } = await supabase.from('reminder_emails').update({ status: 'dropped' }).in('id', ids);
    setBusy(false);
    if (e) { setError(`Could not drop: ${e.message}`); return; }
    setNotice(`${ids.length} dropped.`);
    setSelected(new Set());
    load(); onChanged && onChanged();
  };

  const release = async () => {
    if (!canManage || !selected.size) return;
    if (!window.confirm(`Release ${selected.size} email${selected.size === 1 ? '' : 's'} now? They will be sent to clients.`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const { data, error: e } = await supabase.functions.invoke('reminders-send', {
        body: { mode: 'release', comm_type: commType, ids: [...selected] },
      });
      if (e) throw new Error(e.message || 'Release failed');
      if (data && data.success === false) throw new Error(data.error || 'Release failed');
      const bits = [`${data?.sent ?? 0} sent`];
      if (data?.skipped?.length) bits.push(`${data.skipped.length} skipped`);
      if (data?.errors?.length) bits.push(`${data.errors.length} failed`);
      setNotice(bits.join(', ') + '.');
      setSelected(new Set());
      load(); onChanged && onChanged();
    } catch (ex) {
      setError(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay}>
      <div style={{ ...card, width: 1080, maxWidth: '96vw', maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 20, fontFamily: font }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Review queue</div>
          <span style={{ marginLeft: 10, fontSize: 12, color: '#64748b' }}>{rows.length} queued · {selected.size} selected</span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#64748b', cursor: 'pointer', fontFamily: font }}>×</button>
        </div>

        {error && <div style={{ ...card, padding: '9px 12px', marginBottom: 10, background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c', fontSize: 12.5 }}>{error}</div>}
        {notice && <div style={{ ...card, padding: '9px 12px', marginBottom: 10, background: '#f0fdf4', borderColor: '#bbf7d0', color: '#166534', fontSize: 12.5 }}>{notice}</div>}
        {!canManage && <div style={{ ...card, padding: '9px 12px', marginBottom: 10, background: '#f8fafc', color: '#475569', fontSize: 12 }}>Reviewing only — releasing is limited to portal managers.</div>}

        <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
          {/* list */}
          <div style={{ flex: '1 1 520px', minWidth: 340, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 28 }}><input type="checkbox" checked={allSel} onChange={toggleAll} /></th>
                  <th style={th}>Client</th>
                  <th style={th}>Email</th>
                  <th style={th}>Kind</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td style={td} colSpan={4}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td style={{ ...td, color: '#94a3b8' }} colSpan={4}>Nothing queued. Select clients on the reminders page and choose “Add to queue”.</td></tr>
                ) : rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setFocusId(r.id)}
                    style={{ cursor: 'pointer', background: r.id === focusId ? '#f8fbff' : 'transparent' }}
                  >
                    <td style={td} onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    </td>
                    <td style={{ ...td, fontWeight: 600 }}>{nameOf(r)}</td>
                    <td style={{ ...td, color: '#334155' }}>{r.to_email}</td>
                    <td style={td}>{r.kind === 'promo' ? 'opt-in' : 'reminder'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* preview */}
          <div style={{ flex: '1 1 420px', minWidth: 300, overflowY: 'auto' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
              Exactly what will send
            </div>
            {focus ? (
              <>
                <div style={{ fontSize: 12.5, color: '#334155', margin: '2px 0 8px' }}>
                  To <strong>{focus.to_email}</strong> · Subject: <strong>{focus.subject}</strong>
                </div>
                <div
                  style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '4px 10px', background: '#fff' }}
                  dangerouslySetInnerHTML={{ __html: focus.body_html || '<p>(no body stored)</p>' }}
                />
              </>
            ) : <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Select a row to preview.</div>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
          <button onClick={drop} disabled={!canManage || !selected.size || busy} style={btnDanger(canManage && selected.size > 0 && !busy)}>
            Drop selected
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={btnGhost}>Close</button>
          <button onClick={release} disabled={!canManage || !selected.size || busy} style={btnPrimary(canManage && selected.size > 0 && !busy)}>
            {busy ? 'Working…' : `Release ${selected.size || ''} now`}
          </button>
        </div>
      </div>
    </div>
  );
}
