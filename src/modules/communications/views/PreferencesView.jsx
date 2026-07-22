import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../shell/AppShell';

/*
  Client Preferences — the consent ledger for every client communication
  type. Rows come from client_comm_preferences (written by the tokened
  opt-in links in comm-optin, by email replies, or by staff overrides);
  comm_types is the catalogue those rows point at, so new types
  (marketing, newsletters, general updates …) appear here automatically
  once seeded — no code change needed.

  Former clients are excluded at read time (entity_status nlac/archived),
  in line with the practice-wide NLAC read-time filter.
*/

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };
const FORMER = new Set(['nlac', 'archived']);

const PREF_META = {
  opted_in: { label: 'Opted in', bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
  opted_out: { label: 'Opted out', bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
  pending: { label: 'Pending', bg: '#fffbeb', color: '#92400e', border: '#fde68a' },
};
const VIA_LABEL = {
  email_link: 'Client · opt-in link',
  email_reply: 'Client · email reply',
  staff: 'Staff',
};

const th = {
  padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#64748b',
  textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4,
  borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const td = { padding: '7px 10px', fontSize: 12.5, color: '#1e293b', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' };
const selStyle = {
  padding: '4px 8px', fontSize: 12, fontFamily: font, color: '#334155',
  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer',
};

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function PrefChip({ status }) {
  const m = PREF_META[status];
  if (!m) return <span style={{ color: '#94a3b8', fontSize: 12 }}>—</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', fontSize: 11, fontWeight: 600,
      background: m.bg, color: m.color, border: `1px solid ${m.border}`, borderRadius: 999,
    }}>{m.label}</span>
  );
}

export default function PreferencesView() {
  const { profile } = useAuth();
  const canManage = profile?.can_manage_portal === true;

  const [commTypes, setCommTypes] = useState([]);
  const [prefs, setPrefs] = useState([]);
  const [entityById, setEntityById] = useState({});
  const [staffById, setStaffById] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: types, error: e1 }, { data: p, error: e2 }, { data: ents, error: e3 }, { data: staff }] = await Promise.all([
        supabase.from('comm_types').select('id, label, active').order('label'),
        supabase.from('client_comm_preferences').select('*'),
        supabase.from('entities').select('id, name, entity_status').order('name'),
        supabase.from('staff_profiles').select('id, name'),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      if (e3) throw e3;
      setCommTypes(types || []);
      setPrefs(p || []);
      setEntityById(Object.fromEntries((ents || []).map((e) => [e.id, e])));
      setStaffById(Object.fromEntries((staff || []).map((s) => [s.id, s.name])));
      setError(null);
    } catch (ex) {
      setError(`Could not load preferences: ${ex.message || String(ex)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const typeLabel = useMemo(() => {
    const m = Object.fromEntries(commTypes.map((t) => [t.id, t.label || t.id]));
    return (id) => m[id] || id;
  }, [commTypes]);

  // Recorded preferences joined to a live (non-former) client.
  const rows = useMemo(() => {
    return (prefs || [])
      .map((p) => ({ ...p, entity: entityById[p.entity_id] || null }))
      .filter((r) => r.entity && !FORMER.has(r.entity.entity_status))
      .sort((a, b) => (a.entity.name || '').localeCompare(b.entity.name || ''));
  }, [prefs, entityById]);

  const typeScoped = useMemo(
    () => rows.filter((r) => typeFilter === 'all' || r.comm_type === typeFilter),
    [rows, typeFilter]
  );

  const counts = useMemo(() => {
    const c = { opted_in: 0, opted_out: 0, pending: 0 };
    for (const r of typeScoped) if (c[r.status] !== undefined) c[r.status] += 1;
    return c;
  }, [typeScoped]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return typeScoped.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (q && !(r.entity.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [typeScoped, statusFilter, search]);

  const setPreference = async (row, status) => {
    if (!canManage || !status || status === row.status) return;
    const now = new Date().toISOString();
    const rec = {
      entity_id: row.entity_id,
      comm_type: row.comm_type,
      status,
      decided_at: status === 'pending' ? null : now,
      decided_via: status === 'pending' ? null : 'staff',
      decided_by: status === 'pending' ? null : (profile?.id || null),
      updated_at: now,
    };
    const { data, error: e } = await supabase
      .from('client_comm_preferences')
      .upsert(rec, { onConflict: 'entity_id,comm_type' })
      .select('*')
      .single();
    if (e) { setError(`Could not save the preference: ${e.message}`); return; }
    setPrefs((cur) => cur.map((p) =>
      (p.entity_id === row.entity_id && p.comm_type === row.comm_type) ? { ...p, ...(data || rec) } : p
    ));
  };

  const SummaryChip = ({ label, value, tone }) => (
    <div style={{ ...card, padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 96 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color: tone }}>{value}</span>
    </div>
  );

  return (
    <div style={{ fontFamily: font, height: '100%', overflowY: 'auto', paddingRight: 2 }}>
      <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 14px', maxWidth: 720 }}>
        Consent ledger for client communications. Responses arrive from opt-in
        links, email replies, or staff. New communication types appear here
        automatically once added. Former clients are hidden.
      </p>

      {error && (
        <div style={{ ...card, padding: '10px 14px', marginBottom: 12, background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c', fontSize: 12.5 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <SummaryChip label="Opted in" value={counts.opted_in} tone="#166534" />
        <SummaryChip label="Opted out" value={counts.opted_out} tone="#b91c1c" />
        <SummaryChip label="Pending" value={counts.pending} tone="#92400e" />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selStyle}>
          <option value="all">All communication types</option>
          {commTypes.map((t) => <option key={t.id} value={t.id}>{t.label || t.id}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selStyle}>
          <option value="all">All statuses</option>
          <option value="opted_in">Opted in</option>
          <option value="opted_out">Opted out</option>
          <option value="pending">Pending</option>
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search client…"
          style={{ ...selStyle, minWidth: 200, cursor: 'text' }}
        />
        <span style={{ fontSize: 12, color: '#94a3b8' }}>{visible.length} shown</span>
      </div>

      <div style={{ ...card, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Client</th>
              <th style={th}>Communication type</th>
              <th style={th}>Status</th>
              <th style={th}>Decided</th>
              <th style={th}>Source</th>
              {canManage && <th style={th}>Set</th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={td} colSpan={canManage ? 6 : 5}>Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td style={{ ...td, color: '#94a3b8' }} colSpan={canManage ? 6 : 5}>No recorded preferences match.</td></tr>
            ) : visible.map((r) => (
              <tr key={`${r.entity_id}:${r.comm_type}`}>
                <td style={{ ...td, fontWeight: 600 }}>{r.entity.name}</td>
                <td style={td}>{typeLabel(r.comm_type)}</td>
                <td style={td}><PrefChip status={r.status} /></td>
                <td style={{ ...td, color: '#64748b' }}>{fmtDateTime(r.decided_at)}</td>
                <td style={{ ...td, color: '#64748b' }}>
                  {VIA_LABEL[r.decided_via] || '—'}
                  {r.decided_via === 'staff' && staffById[r.decided_by] && (
                    <span style={{ color: '#94a3b8' }}> · {staffById[r.decided_by]}</span>
                  )}
                </td>
                {canManage && (
                  <td style={td}>
                    <select
                      value=""
                      onChange={(e) => { setPreference(r, e.target.value); e.target.value = ''; }}
                      style={selStyle}
                    >
                      <option value="">Change…</option>
                      <option value="opted_in">Opted in</option>
                      <option value="opted_out">Opted out</option>
                      <option value="pending">Pending</option>
                    </select>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
