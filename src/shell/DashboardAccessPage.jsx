import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Plus, X, RotateCcw, Info, Eye, Loader } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AppShell';
import ClientViewPreview from '../modules/client-dashboard/ClientViewPreview';

const font = "'Outfit', sans-serif";

/*
  Client Dashboard Access — /admin/dashboard-access (can_manage_portal only).

  Who, among the client-portal logins, can see a client dashboard, and how much
  of it. This is the only place a client is ever given financial figures, so it
  is one screen with the whole picture on it rather than a switch buried in a
  client record.

  Two things the screen has to make obvious, because getting either wrong is the
  kind of mistake that matters:

    • A grant is ONE person and ONE client. There is no "all clients" shape here
      by design — Marc Kelly gets Puddleduck and only Puddleduck.
    • Sections are separate. Overview and P&L are the default; the balance
      sheet, the underlying (owner costs removed) view and the projection are
      each off until switched on, because a forecast a client can see is a
      commitment and the underlying view exposes which of their codes we have
      classed as personal spending.

  Granting also issues a portal invite if they haven't one, so access and a way
  to sign in never come apart. Revoking is soft — the row stays with a revoked
  date, so "who could see what, when" stays answerable.

  All reads and writes go through SECURITY DEFINER RPCs from
  sql/238_client_dashboard_access.sql, every one of them gated on
  can_manage_portal server-side. The client's own read is portal_my_dashboards(),
  which filters to their verified email claim and never touches this page.
*/

const SECTIONS = [
  { key: 'show_overview', label: 'Overview', hint: 'Headline figures, trend chart, key ratios.' },
  { key: 'show_pl', label: 'P&L', hint: 'Income and cost detail by period.' },
  { key: 'show_balance', label: 'Balance sheet', hint: 'Assets, liabilities and the month-by-month comparatives.' },
  { key: 'show_underlying', label: 'Underlying', hint: 'Owner costs and one-offs stripped out. Exposes which nominal codes we treat as the owner\'s personal spending.' },
  { key: 'show_projection', label: 'Projection', hint: 'The linked forecast scenario. A forecast a client can see is a commitment.' },
];

const fmtDate = (d) =>
  (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export default function DashboardAccessPage() {
  const { profile } = useAuth();
  const canManage = profile?.can_manage_portal === true;

  const [rows, setRows] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);
  // Held as an id, not the row: the preview panel lets you flip sections while
  // it is open, and it has to re-read the row that the toggle just changed.
  const [previewId, setPreviewId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: access, error: aErr }, { data: cl }] = await Promise.all([
        supabase.rpc('list_dashboard_access'),
        supabase.rpc('dashboard_grantable_clients'),
      ]);
      if (aErr) throw aErr;
      setRows(access || []);
      setClients(cl || []);
    } catch (e) {
      setMsg({ tone: 'error', text: String(e.message || e) });
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (canManage) load(); }, [canManage, load]);

  const live = useMemo(() => rows.filter((r) => !r.revoked_at), [rows]);
  const previewRow = useMemo(() => rows.find((r) => r.id === previewId) || null, [rows, previewId]);
  const revoked = useMemo(() => rows.filter((r) => r.revoked_at), [rows]);

  const toggle = async (row, key) => {
    setBusy(row.id);
    setMsg(null);
    try {
      const { error } = await supabase.rpc('set_dashboard_access_flags', {
        p_id: row.id, p_flags: { [key]: !row[key] },
      });
      if (error) throw error;
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, [key]: !r[key] } : r)));
    } catch (e) {
      setMsg({ tone: 'error', text: String(e.message || e) });
      await load();
    }
    setBusy(null);
  };

  const revoke = async (row) => {
    if (!window.confirm(
      `Remove ${row.email}'s dashboard access to ${row.entity_name}?\n\n`
      + 'They keep their portal login and anything else it gives them — only the '
      + 'financial dashboard goes. The grant is kept with a revoked date so the '
      + 'history stays answerable.',
    )) return;
    setBusy(row.id);
    setMsg(null);
    try {
      const { error } = await supabase.rpc('revoke_dashboard_access', { p_id: row.id, p_hard: false });
      if (error) throw error;
      setMsg({ tone: 'success', text: `Dashboard access removed for ${row.email}.` });
      await load();
    } catch (e) { setMsg({ tone: 'error', text: String(e.message || e) }); }
    setBusy(null);
  };

  const restore = async (row) => {
    setBusy(row.id);
    setMsg(null);
    try {
      const { error } = await supabase.rpc('grant_dashboard_access', {
        p_email: row.email,
        p_entity_id: row.entity_id,
        p_flags: SECTIONS.reduce((a, s) => ({ ...a, [s.key]: row[s.key] }), {}),
      });
      if (error) throw error;
      setMsg({ tone: 'success', text: `Dashboard access restored for ${row.email}.` });
      await load();
    } catch (e) { setMsg({ tone: 'error', text: String(e.message || e) }); }
    setBusy(null);
  };

  if (!canManage) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px', fontFamily: font }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', marginBottom: 8 }}>
          Client Dashboard Access
        </h1>
        <p style={{ fontSize: 14, color: '#64748b' }}>
          You need the Portal admin permission to give clients access to their dashboards.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px 60px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
        <BarChart3 size={26} style={{ color: '#38bdf8', marginTop: 4 }} />
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', margin: 0 }}>
            Client Dashboard Access
          </h1>
          <p style={{ fontSize: 13.5, color: '#64748b', margin: '4px 0 0', maxWidth: 760, lineHeight: 1.6 }}>
            Which client-portal logins can see a client dashboard, and which parts of it. One grant is
            one person and one client — nobody here can see anything beyond the clients listed against
            their own email.
          </p>
        </div>
        <button
          onClick={() => setAdding(true)}
          style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 7,
            padding: '10px 18px', border: 'none', borderRadius: 10, backgroundColor: '#0f172a',
            color: '#fff', fontFamily: font, fontSize: 13.5, fontWeight: 700, cursor: 'pointer',
          }}
        >
          <Plus size={15} /> Give access
        </button>
      </div>

      {msg && (
        <div style={{
          marginTop: 16, padding: '10px 14px', borderRadius: 10, fontSize: 13.5,
          backgroundColor: msg.tone === 'error' ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${msg.tone === 'error' ? '#fecaca' : '#bbf7d0'}`,
          color: msg.tone === 'error' ? '#991b1b' : '#166534',
        }}>
          {msg.text}
        </div>
      )}

      <div style={{
        marginTop: 18, display: 'flex', gap: 9, alignItems: 'flex-start',
        padding: '11px 15px', backgroundColor: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 11,
      }}>
        <Info size={15} style={{ color: '#94a3b8', flexShrink: 0, marginTop: 1 }} />
        <span style={{ fontSize: 12.5, color: '#64748b', lineHeight: 1.6 }}>
          Giving access also issues a portal invite if the person hasn't one, so they can actually sign
          in. It does not send an email — do that from the client's onboarding screen, or just tell them.
          The client only ever sees cached or freshly pulled QuickBooks figures; nothing internal
          (bookkeeping health, drift, staff notes) is reachable from the portal.
        </span>
      </div>

      {loading && <p style={{ fontSize: 14, color: '#94a3b8', marginTop: 24 }}>Loading…</p>}

      {!loading && live.length === 0 && (
        <div style={{
          marginTop: 24, padding: '44px 24px', textAlign: 'center',
          border: '1px dashed #cbd5e1', borderRadius: 14, color: '#64748b', fontSize: 14,
        }}>
          No client has dashboard access yet.
        </div>
      )}

      {!loading && live.length > 0 && (
        <AccessTable
          rows={live} busy={busy} onToggle={toggle}
          action={(r) => (
            <span style={{ display: 'inline-flex', gap: 6 }}>
              <button onClick={() => setPreviewId(r.id)} disabled={!r.realm_id} style={linkishBtn}
                title={r.realm_id ? `See exactly what ${r.email} sees` : 'No live QuickBooks connection to preview'}>
                <Eye size={13} /> Preview
              </button>
              <button onClick={() => revoke(r)} disabled={busy === r.id} style={dangerBtn}>
                <X size={13} /> Remove
              </button>
            </span>
          )}
        />
      )}

      {revoked.length > 0 && (
        <div style={{ marginTop: 26 }}>
          <button
            onClick={() => setShowRevoked((x) => !x)}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: font, fontSize: 13, fontWeight: 600, color: '#64748b' }}
          >
            {showRevoked ? '▾' : '▸'} Previously removed ({revoked.length})
          </button>
          {showRevoked && (
            <AccessTable
              rows={revoked} busy={busy} readOnly
              action={(r) => (
                <button onClick={() => restore(r)} disabled={busy === r.id} style={linkishBtn}>
                  <RotateCcw size={13} /> Restore
                </button>
              )}
            />
          )}
        </div>
      )}

      {previewRow && (
        <ClientViewPreview row={previewRow} onToggle={toggle} busy={busy} onClose={() => setPreviewId(null)} />
      )}

      {adding && (
        <GrantModal
          clients={clients}
          existing={rows}
          onClose={() => setAdding(false)}
          onDone={async (text) => { setAdding(false); setMsg({ tone: 'success', text }); await load(); }}
          onError={(text) => setMsg({ tone: 'error', text })}
        />
      )}
    </div>
  );
}

/* ─── Table ────────────────────────────────────────────────────── */
function AccessTable({ rows, busy, onToggle, action, readOnly }) {
  return (
    <div style={{ marginTop: 16, overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 14 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 940 }}>
        <thead>
          <tr>
            <th style={th}>Person</th>
            <th style={th}>Client</th>
            {SECTIONS.map((s) => (
              <th key={s.key} style={{ ...th, textAlign: 'center' }} title={s.hint}>{s.label}</th>
            ))}
            <th style={th}>Granted</th>
            <th style={th}>Last viewed</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={td}>
                <div style={{ fontWeight: 600, color: '#0f172a' }}>{r.email}</div>
                <div style={{ fontSize: 11.5, color: r.has_portal_login ? '#94a3b8' : '#b45309' }}>
                  {r.has_portal_login
                    ? 'has signed in'
                    : r.has_invite ? 'invited — not signed in yet' : 'no invite'}
                </div>
              </td>
              <td style={td}>
                <div style={{ color: '#0f172a' }}>{r.entity_name}</div>
                <div style={{ fontSize: 11.5, color: r.realm_id ? '#94a3b8' : '#b45309' }}>
                  {r.realm_id ? (r.company_name || 'QuickBooks connected') : 'no live QuickBooks connection'}
                </div>
              </td>
              {SECTIONS.map((s) => (
                <td key={s.key} style={{ ...td, textAlign: 'center' }}>
                  {readOnly ? (
                    <span style={{ color: r[s.key] ? '#166534' : '#cbd5e1' }}>{r[s.key] ? '✓' : '—'}</span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={!!r[s.key]}
                      disabled={busy === r.id}
                      onChange={() => onToggle(r, s.key)}
                      title={s.hint}
                      style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#0f172a' }}
                    />
                  )}
                </td>
              ))}
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                {fmtDate(r.granted_at)}
                {r.granted_by_name && <div style={{ fontSize: 11.5, color: '#94a3b8' }}>by {r.granted_by_name}</div>}
              </td>
              <td style={{ ...td, whiteSpace: 'nowrap', color: r.last_viewed_at ? '#334155' : '#cbd5e1' }}>
                {r.last_viewed_at ? fmtDate(r.last_viewed_at) : 'never'}
              </td>
              <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{action(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Grant modal ──────────────────────────────────────────────── */
function GrantModal({ clients, existing, onClose, onDone, onError }) {
  const [entityId, setEntityId] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [flags, setFlags] = useState({
    show_overview: true, show_pl: true,
    show_balance: false, show_underlying: false, show_projection: false,
  });
  const [contacts, setContacts] = useState([]);
  const [saving, setSaving] = useState(false);

  // Offer the client's own contacts rather than making someone retype an email
  // they'll get subtly wrong — a typo here grants nobody anything and looks like
  // it worked.
  useEffect(() => {
    if (!entityId) { setContacts([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('entity_people')
          .select('role, is_primary_contact, people(name, email)')
          .eq('entity_id', entityId);
        if (cancelled) return;
        const seen = new Map();
        for (const r of data || []) {
          const e = (r.people?.email || '').trim().toLowerCase();
          if (!e) continue;
          if (!seen.has(e)) seen.set(e, { email: e, name: r.people?.name || '', roles: [] });
          seen.get(e).roles.push(r.role);
        }
        setContacts([...seen.values()]);
      } catch { setContacts([]); }
    })();
    return () => { cancelled = true; };
  }, [entityId]);

  const clash = existing.find(
    (r) => r.entity_id === entityId && r.email.toLowerCase() === email.trim().toLowerCase() && !r.revoked_at,
  );

  const submit = async () => {
    setSaving(true);
    try {
      const { error } = await supabase.rpc('grant_dashboard_access', {
        p_email: email.trim(),
        p_entity_id: entityId,
        p_flags: flags,
        p_note: note.trim() || null,
      });
      if (error) throw error;
      const client = clients.find((c) => c.entity_id === entityId);
      onDone(`${email.trim().toLowerCase()} can now see the ${client?.entity_name || 'client'} dashboard.`);
    } catch (e) {
      onError(String(e.message || e));
      setSaving(false);
    }
  };

  const valid = entityId && /\S+@\S+\.\S+/.test(email.trim());

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(15,23,42,0.45)', zIndex: 70,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#fff', borderRadius: 16, width: '100%', maxWidth: 560,
          maxHeight: '86vh', overflowY: 'auto', fontFamily: font,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
          <BarChart3 size={17} style={{ color: '#38bdf8' }} />
          <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>Give dashboard access</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}>
            <X size={18} style={{ color: '#94a3b8' }} />
          </button>
        </div>

        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={fieldLabel}>
            Client
            <select value={entityId} onChange={(e) => { setEntityId(e.target.value); setEmail(''); }} style={input}>
              <option value="">Choose a client…</option>
              {clients.map((c) => (
                <option key={c.entity_id} value={c.entity_id}>{c.entity_name}</option>
              ))}
            </select>
            <span style={hint}>Only clients with a live QuickBooks connection can be shown a dashboard.</span>
          </label>

          <label style={fieldLabel}>
            Their email
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.co.uk" style={input}
            />
            {contacts.length > 0 && (
              <span style={{ ...hint, display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {contacts.map((c) => (
                  <button
                    key={c.email} type="button" onClick={() => setEmail(c.email)}
                    style={{
                      border: '1px solid #e5e7eb', borderRadius: 999, padding: '4px 11px',
                      background: email === c.email ? '#f0f9ff' : '#fff', cursor: 'pointer',
                      fontFamily: font, fontSize: 11.5, color: '#334155',
                    }}
                  >
                    {c.name || c.email}
                    <span style={{ color: '#94a3b8' }}> · {[...new Set(c.roles)].join('/')}</span>
                  </button>
                ))}
              </span>
            )}
            {clash && (
              <span style={{ ...hint, color: '#b45309' }}>
                This person already has access to that client — saving will update their sections.
              </span>
            )}
          </label>

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#94a3b8', marginBottom: 8 }}>
              What they can see
            </div>
            {SECTIONS.map((s) => (
              <label key={s.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 0', cursor: 'pointer' }}>
                <input
                  type="checkbox" checked={!!flags[s.key]}
                  onChange={() => setFlags((f) => ({ ...f, [s.key]: !f[s.key] }))}
                  style={{ width: 16, height: 16, marginTop: 2, cursor: 'pointer', accentColor: '#0f172a' }}
                />
                <span>
                  <span style={{ fontSize: 13.5, color: '#0f172a', fontWeight: 600 }}>{s.label}</span>
                  <span style={{ display: 'block', fontSize: 11.5, color: '#94a3b8', lineHeight: 1.5 }}>{s.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <label style={fieldLabel}>
            Note (optional)
            <input
              value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Why they have this" style={input}
            />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 22px', borderTop: '1px solid #e5e7eb' }}>
          <button onClick={onClose} style={linkishBtn}>Cancel</button>
          <button
            onClick={submit} disabled={!valid || saving}
            style={{
              padding: '10px 20px', border: 'none', borderRadius: 10,
              backgroundColor: valid && !saving ? '#0f172a' : '#cbd5e1', color: '#fff',
              fontFamily: font, fontSize: 13.5, fontWeight: 700,
              cursor: valid && !saving ? 'pointer' : 'not-allowed',
            }}
          >
            {saving ? 'Saving…' : 'Give access'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Styles ───────────────────────────────────────────────────── */
const th = {
  textAlign: 'left', padding: '10px 14px', fontWeight: 600, color: '#0f172a',
  borderBottom: '2px solid #e5e7eb', whiteSpace: 'nowrap', fontSize: 12.5,
  backgroundColor: '#f8fafc',
};
const td = { padding: '11px 14px', borderBottom: '1px solid #f1f5f9', fontSize: 13, color: '#334155' };
const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#475569' };
const hint = { fontSize: 11.5, color: '#94a3b8', fontWeight: 400, lineHeight: 1.5 };
const input = {
  border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 12px',
  fontSize: 13.5, fontFamily: font, outline: 'none', boxSizing: 'border-box', width: '100%',
};
const dangerBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid #fecaca',
  borderRadius: 8, padding: '6px 12px', background: '#fff', color: '#b91c1c',
  fontFamily: font, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
};
const linkishBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid #e5e7eb',
  borderRadius: 8, padding: '6px 12px', background: '#fff', color: '#475569',
  fontFamily: font, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
};
