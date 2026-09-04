import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, Plus, X, RotateCcw, Info, Loader, Check } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { OUTFIT, cardStyle, inputStyle, shortDate } from './dashboardData';
import ClientViewPreview from './ClientViewPreview';

/*
  Client access — who, on THIS client, can see their own dashboard, and what of.

  /admin/dashboard-access answers the same question across the whole practice,
  which is the right screen for an audit ("who can see anything?") and the wrong
  one for the moment the question actually comes up. That moment is here: you are
  on Puddleduck's dashboard, on the phone to Puddleduck, and they ask whether
  they can see this themselves. Sending yourself to another screen, finding the
  client in a list of every grant in the practice, and coming back is how a
  five-second answer becomes a task for later.

  So this tab is the same controls scoped to the client already on screen, and it
  is the same RPCs underneath — no second copy of the authorisation rules. Both
  screens are gated on can_manage_portal, server-side, in every RPC.

  It also does the one thing the practice-wide screen cannot sensibly do:
  publish a custom REPORT to the client. A report is scoped to a client (or a
  sector, or everybody), and deciding "this one is finished enough to show them"
  belongs beside the client whose figures are in it. Two flags have to agree
  before a client sees a report — `show_reports` on their grant and
  `is_client_visible` on the report — so building a report never publishes it.
*/

// Order matters: the standard offer first, then the two that are a decision.
export const SECTIONS = [
  { key: 'show_overview', label: 'Overview', hint: 'Headline figures, the trend chart and their front-page measures.' },
  { key: 'show_pl', label: 'P&L', hint: 'The profit and loss, their own date range, expandable to account level.' },
  { key: 'show_balance', label: 'Balance sheet', hint: 'The balance sheet at a date they choose, with a comparative.' },
  { key: 'show_debtors', label: 'Debtors', hint: 'Aged debtors — their own sales ledger, with the largest balances named.' },
  { key: 'show_creditors', label: 'Creditors', hint: 'Aged creditors — their own purchase ledger, with the largest balances named.' },
  { key: 'show_kpis', label: 'Measures', hint: 'The KPI pack for their sector plus anything bespoke. Read-only for them.' },
  { key: 'show_reports', label: 'Reports', hint: 'Custom reports — and only the ones published to the client below.' },
  { key: 'show_underlying', label: 'Underlying', hint: 'Owner costs and one-offs stripped out. Exposes which nominal codes we treat as the owner\'s personal spending. Off by default.' },
  { key: 'show_projection', label: 'Projection', hint: 'The linked forecast scenario. A forecast a client can see is a commitment. Off by default.' },
];

const STANDARD = SECTIONS.reduce((a, s) => ({
  ...a,
  [s.key]: s.key !== 'show_underlying' && s.key !== 'show_projection',
}), {});

const fmtDate = (d) => (d ? shortDate(d) : '—');

export default function ClientAccessTab({ entityId, clientName, realmId, canManage }) {
  const [rows, setRows] = useState([]);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);
  // Held as an id, not the row: the preview lets you flip sections while it is
  // open, and it has to re-read the row that the toggle just changed.
  const [previewId, setPreviewId] = useState(null);

  const load = useCallback(async () => {
    if (!entityId || !canManage) { setRows([]); setReports([]); setLoading(false); return; }
    setLoading(true);
    try {
      const [{ data: access, error: aErr }, { data: reps }] = await Promise.all([
        supabase.rpc('list_dashboard_access'),
        // A report reaches this client if it is theirs, their sector's, or
        // everybody's — the same scope rule the Reports tab applies.
        supabase.rpc('dashboard_reports_for_entity', { p_entity_id: entityId }),
      ]);
      if (aErr) throw aErr;
      setRows((access || []).filter((r) => r.entity_id === entityId));
      setReports(reps || []);
    } catch (e) {
      setMsg({ tone: 'error', text: String(e.message || e) });
    }
    setLoading(false);
  }, [entityId, canManage]);

  useEffect(() => { load(); }, [load]);

  const live = useMemo(() => rows.filter((r) => !r.revoked_at), [rows]);
  const revoked = useMemo(() => rows.filter((r) => r.revoked_at), [rows]);
  const previewRow = useMemo(() => rows.find((r) => r.id === previewId) || null, [rows, previewId]);

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

  const publish = async (report) => {
    setBusy(report.id);
    setMsg(null);
    try {
      // Through the RPC, not a table write: publishing decides whether a
      // CLIENT may look, which is a can_manage_portal decision, and the table's
      // own RLS gates on who OWNS the report instead. See sql/275.
      const { error } = await supabase.rpc('set_report_client_visible', {
        p_id: report.id, p_visible: !report.is_client_visible,
      });
      if (error) throw error;
      setReports((prev) => prev.map((r) => (
        r.id === report.id ? { ...r, is_client_visible: !r.is_client_visible } : r
      )));
    } catch (e) {
      setMsg({ tone: 'error', text: String(e.message || e) });
      await load();
    }
    setBusy(null);
  };

  if (!canManage) {
    return (
      <div style={cardStyle}>
        <p style={{ fontFamily: OUTFIT, fontSize: 13.5, color: '#64748b', margin: 0, lineHeight: 1.6 }}>
          Giving a client sight of their own figures needs the Portal admin permission.
          Ask Bobby, Tracy or whoever holds it — the whole picture is on
          {' '}<strong>Admin → Client Dashboard Access</strong>.
        </p>
      </div>
    );
  }

  if (!entityId) {
    return (
      <div style={cardStyle}>
        <p style={{ fontFamily: OUTFIT, fontSize: 13.5, color: '#64748b', margin: 0 }}>
          Choose a client first.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontFamily: OUTFIT, fontSize: 15, fontWeight: 700, color: '#0f172a' }}>
              Who can see {clientName || 'this client'}'s own dashboard
            </div>
            <p style={{ fontFamily: OUTFIT, fontSize: 12.5, color: '#64748b', margin: '5px 0 0', lineHeight: 1.6 }}>
              One grant is one person and one client. They see the same reports and the same
              controls we do — their own date range, the same comparatives, rows that expand to
              account level — filtered to the sections ticked here.
            </p>
          </div>
          <button
            onClick={() => setAdding(true)}
            disabled={!realmId}
            title={realmId ? undefined : 'This client has no live QuickBooks connection, so there would be nothing to show.'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px',
              border: 'none', borderRadius: 10, backgroundColor: realmId ? '#0f172a' : '#cbd5e1',
              color: '#fff', fontFamily: OUTFIT, fontSize: 13, fontWeight: 700,
              cursor: realmId ? 'pointer' : 'not-allowed',
            }}
          >
            <Plus size={15} /> Give access
          </button>
        </div>

        {msg && (
          <div style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 10, fontFamily: OUTFIT, fontSize: 13,
            backgroundColor: msg.tone === 'error' ? '#fef2f2' : '#f0fdf4',
            border: `1px solid ${msg.tone === 'error' ? '#fecaca' : '#bbf7d0'}`,
            color: msg.tone === 'error' ? '#991b1b' : '#166534',
          }}>
            {msg.text}
          </div>
        )}

        <div style={{
          marginTop: 14, display: 'flex', gap: 9, alignItems: 'flex-start',
          padding: '11px 15px', backgroundColor: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 11,
        }}>
          <Info size={15} style={{ color: '#94a3b8', flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontFamily: OUTFIT, fontSize: 12.5, color: '#64748b', lineHeight: 1.6 }}>
            Giving access also issues a portal invite if they haven't one, so they can actually sign
            in. It sends no email — tell them, or send it from their onboarding screen. Nothing
            internal is reachable from the portal: not bookkeeping health, not drift scores, not our
            notes. <strong>Preview</strong> fetches their view through their own endpoint, so what you
            see there is what they get.
          </span>
        </div>
      </div>

      {loading && (
        <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 9, color: '#94a3b8', fontFamily: OUTFIT, fontSize: 13 }}>
          <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
        </div>
      )}

      {!loading && live.length === 0 && (
        <div style={{
          padding: '38px 24px', textAlign: 'center', border: '1px dashed #cbd5e1',
          borderRadius: 14, color: '#64748b', fontFamily: OUTFIT, fontSize: 13.5,
        }}>
          Nobody at {clientName || 'this client'} can see their dashboard yet.
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
        <div>
          <button
            onClick={() => setShowRevoked((x) => !x)}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: OUTFIT, fontSize: 13, fontWeight: 600, color: '#64748b' }}
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

      {/* ── Reports published to the client ────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontFamily: OUTFIT, fontSize: 15, fontWeight: 700, color: '#0f172a' }}>
          Reports published to the client
        </div>
        <p style={{ fontFamily: OUTFIT, fontSize: 12.5, color: '#64748b', margin: '5px 0 12px', lineHeight: 1.6 }}>
          A report is a working paper until you publish it. Published reports appear as their own tab
          on the client's dashboard, and only for people whose grant has <strong>Reports</strong>
          {' '}ticked above — so a report published here still shows nobody anything until somebody
          holds that section.
        </p>

        {reports.length === 0 && (
          <div style={{ fontFamily: OUTFIT, fontSize: 13, color: '#94a3b8' }}>
            No custom reports reach this client yet. Build one on the Reports tab.
          </div>
        )}

        {reports.map((r) => (
          <div key={r.id} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
            borderTop: '1px solid #f1f5f9',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: OUTFIT, fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>
                {r.name}
              </div>
              <div style={{ fontFamily: OUTFIT, fontSize: 11.5, color: '#94a3b8' }}>
                {r.entity_id ? 'this client only' : r.sector_id ? 'every client in the sector' : 'practice-wide'}
                {r.description ? ` · ${r.description}` : ''}
              </div>
            </div>
            <button
              onClick={() => publish(r)}
              disabled={busy === r.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                borderRadius: 999, fontFamily: OUTFIT, fontSize: 12, fontWeight: 600,
                cursor: busy === r.id ? 'wait' : 'pointer',
                border: `1px solid ${r.is_client_visible ? '#bbf7d0' : '#e5e7eb'}`,
                background: r.is_client_visible ? '#f0fdf4' : '#fff',
                color: r.is_client_visible ? '#166534' : '#64748b',
              }}
            >
              {r.is_client_visible ? <><Check size={13} /> Published</> : 'Publish to client'}
            </button>
          </div>
        ))}
      </div>

      {previewRow && (
        <ClientViewPreview row={previewRow} onToggle={toggle} busy={busy} onClose={() => setPreviewId(null)} />
      )}

      {adding && (
        <GrantModal
          entityId={entityId}
          clientName={clientName}
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
    <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 14, backgroundColor: '#fff' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1000 }}>
        <thead>
          <tr>
            <th style={th}>Person</th>
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
/*
  The client is fixed — this tab already knows which one. So the only real
  question is WHO, and the answer is nearly always one of their own contacts:
  offering those beats making somebody retype an email they will get subtly
  wrong, because a typo grants nobody anything and looks exactly like it worked.
*/
function GrantModal({ entityId, clientName, existing, onClose, onDone, onError }) {
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [flags, setFlags] = useState(STANDARD);
  const [contacts, setContacts] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
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
    (r) => r.email.toLowerCase() === email.trim().toLowerCase() && !r.revoked_at,
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
      onDone(`${email.trim().toLowerCase()} can now see the ${clientName || 'client'} dashboard.`);
    } catch (e) {
      onError(String(e.message || e));
      setSaving(false);
    }
  };

  const valid = /\S+@\S+\.\S+/.test(email.trim());

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
          maxHeight: '86vh', overflowY: 'auto', fontFamily: OUTFIT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
          <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>
            Give {clientName || 'this client'} dashboard access
          </span>
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}>
            <X size={18} style={{ color: '#94a3b8' }} />
          </button>
        </div>

        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={fieldLabel}>
            Their email
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.co.uk"
              style={inputStyle}
            />
          </label>

          {contacts.length > 0 && (
            <div>
              <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 6 }}>
                Their contacts on file
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {contacts.map((c) => (
                  <button
                    key={c.email}
                    onClick={() => setEmail(c.email)}
                    style={{
                      border: `1px solid ${email === c.email ? '#0f172a' : '#e5e7eb'}`,
                      background: email === c.email ? '#0f172a' : '#fff',
                      color: email === c.email ? '#fff' : '#334155',
                      borderRadius: 999, padding: '5px 12px', fontSize: 12,
                      cursor: 'pointer', fontFamily: OUTFIT,
                    }}
                    title={c.roles.join(', ')}
                  >
                    {c.name || c.email}
                  </button>
                ))}
              </div>
            </div>
          )}

          {clash && (
            <div style={{ fontSize: 12.5, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '9px 13px' }}>
              They already have access to this client. Saving will overwrite their sections with the
              ones ticked below.
            </div>
          )}

          <div>
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 8 }}>
              What they see
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {SECTIONS.map((s) => (
                <label key={s.key} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!flags[s.key]}
                    onChange={() => setFlags((f) => ({ ...f, [s.key]: !f[s.key] }))}
                    style={{ width: 16, height: 16, marginTop: 2, cursor: 'pointer', accentColor: '#0f172a' }}
                  />
                  <span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{s.label}</span>
                    <span style={{ display: 'block', fontSize: 11.5, color: '#94a3b8', lineHeight: 1.5 }}>{s.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <label style={fieldLabel}>
            Note (optional)
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why they have this — read later by whoever wonders"
              style={inputStyle}
            />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 9, justifyContent: 'flex-end', padding: '14px 22px', borderTop: '1px solid #e5e7eb' }}>
          <button onClick={onClose} style={linkishBtn}>Cancel</button>
          <button
            onClick={submit}
            disabled={!valid || saving}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px',
              border: 'none', borderRadius: 10,
              backgroundColor: (!valid || saving) ? '#cbd5e1' : '#0f172a',
              color: '#fff', fontFamily: OUTFIT, fontSize: 13, fontWeight: 700,
              cursor: (!valid || saving) ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={14} />}
            Give access
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Styles ───────────────────────────────────────────────────── */
const th = {
  fontFamily: OUTFIT, fontSize: 11, color: '#94a3b8', fontWeight: 700, textAlign: 'left',
  padding: '10px 12px', whiteSpace: 'nowrap', borderBottom: '1px solid #e5e7eb',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};
const td = {
  fontFamily: OUTFIT, fontSize: 13, color: '#334155', padding: '11px 12px',
  borderBottom: '1px solid #f1f5f9', verticalAlign: 'top',
};
const fieldLabel = {
  display: 'flex', flexDirection: 'column', gap: 6,
  fontFamily: OUTFIT, fontSize: 12, fontWeight: 600, color: '#475569',
};
const linkishBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px',
  border: '1px solid #e5e7eb', borderRadius: 9, background: '#fff',
  fontFamily: OUTFIT, fontSize: 12, fontWeight: 600, color: '#334155', cursor: 'pointer',
};
const dangerBtn = { ...linkishBtn, color: '#991b1b', borderColor: '#fecaca' };
