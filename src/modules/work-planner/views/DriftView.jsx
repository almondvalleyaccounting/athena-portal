import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronRight,
  Link2, RefreshCw, Clock, TrendingDown, Wifi, Star,
} from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../shell/AppShell';
import ClientTypeAhead from '../components/ClientTypeAhead';

/*
 * Work → Drifting.
 *
 * What's behind on the books, split by who is supposed to be keeping them.
 * "Ours" is a work queue — every row is somebody's job. "Theirs" is
 * information: the client keeps those books, so a red row there is something to
 * raise with the client, never a nudge to a colleague.
 *
 * Two independent scores per row, deliberately not merged. Drift is timeliness
 * (how far past tolerance the frontier is); hygiene is mess (suspense
 * balances, an ancient uncleared backlog, a file nobody ever reconciles). A
 * client can be current but messy or spotless and six weeks behind, and those
 * are different jobs.
 */

const FONT = "'Outfit', sans-serif";

const STATUS = {
  critical: { label: 'Critical', bg: '#fef2f2', border: '#fecaca', text: '#b91c1c', dot: '#ef4444', rank: 0 },
  breach:   { label: 'Breach',   bg: '#fff7ed', border: '#fed7aa', text: '#c2410c', dot: '#f97316', rank: 1 },
  watch:    { label: 'Watch',    bg: '#fefce8', border: '#fef08a', text: '#a16207', dot: '#eab308', rank: 2 },
  unknown:  { label: 'Unknown',  bg: '#f5f3ff', border: '#ddd6fe', text: '#6d28d9', dot: '#8b5cf6', rank: 3 },
  paused:   { label: 'Paused',   bg: '#f8fafc', border: '#e2e8f0', text: '#64748b', dot: '#94a3b8', rank: 4 },
  ok:       { label: 'On track', bg: '#f0fdf4', border: '#bbf7d0', text: '#15803d', dot: '#22c55e', rank: 5 },
};

const TIER = {
  critical: { label: 'Never drift', bg: '#fef2f2', text: '#b91c1c', border: '#fecaca' },
  priority: { label: 'Priority',    bg: '#eff6ff', text: '#1d4ed8', border: '#bfdbfe' },
  standard: { label: null },
};

const REASONS = [
  { code: 'waiting_on_client',  label: 'Waiting on client records' },
  { code: 'records_incomplete', label: 'Records incomplete' },
  { code: 'feed_broken',        label: 'Bank feed broken' },
  { code: 'capacity',           label: 'No capacity' },
  { code: 'client_dispute',     label: 'Client dispute / on hold' },
  { code: 'work_in_progress',   label: 'In progress now' },
  { code: 'other',              label: 'Other' },
];

const shortDate = (iso) => (iso
  ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
  : '—');

const card = {
  backgroundColor: '#ffffff', borderRadius: '14px', border: '1px solid #e5e7eb', padding: '16px',
};

function Pill({ tone, children, title }) {
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px', fontFamily: FONT, fontSize: '11.5px',
      fontWeight: 600, color: tone.text, backgroundColor: tone.bg, border: `1px solid ${tone.border}`,
      borderRadius: '999px', padding: '2px 9px', whiteSpace: 'nowrap',
    }}>
      {tone.dot && <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: tone.dot }} />}
      {children}
    </span>
  );
}

function SoftFlag({ icon: Icon, label, title }) {
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px', fontFamily: FONT, fontSize: '11px',
      fontWeight: 600, color: '#7c2d12', backgroundColor: '#fff7ed', border: '1px solid #fed7aa',
      borderRadius: '7px', padding: '2px 7px', whiteSpace: 'nowrap',
    }}>
      <Icon size={11} /> {label}
    </span>
  );
}

/* ── Detail panel ─────────────────────────────────────────────── */

function Frontier({ label, value, sub, muted }) {
  return (
    <div style={{ backgroundColor: '#f8fafc', borderRadius: '10px', padding: '9px 12px', minWidth: '132px' }}>
      <div style={{ fontFamily: FONT, fontSize: '10.5px', color: '#94a3b8', marginBottom: '2px' }}>{label}</div>
      <div style={{ fontFamily: FONT, fontSize: '14px', fontWeight: 700, color: muted ? '#94a3b8' : '#0f172a' }}>
        {value}
      </div>
      {sub && <div style={{ fontFamily: FONT, fontSize: '10.5px', color: '#64748b', marginTop: '1px' }}>{sub}</div>}
    </div>
  );
}

function DetailPanel({ row, staff, onAssign, onPause, onAcknowledge, onDismiss, canApproveTier, onTier }) {
  const [reason, setReason] = useState(row.case_reason || '');
  const [promised, setPromised] = useState(row.case_promised_by || '');
  const [note, setNote] = useState('');
  const [pauseUntil, setPauseUntil] = useState('');
  const [pauseWhy, setPauseWhy] = useState('');
  const [busy, setBusy] = useState(false);

  const accounts = Array.isArray(row.bank_accounts) ? row.bank_accounts : [];
  const notes = Array.isArray(row.notes) ? row.notes : [];
  const live = accounts.filter((a) => a.live);

  const act = async (fn) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };

  return (
    <div style={{ padding: '14px 16px 16px', backgroundColor: '#fbfdff', borderTop: '1px solid #eef2f7' }}>
      {/* Frontiers */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        <Frontier
          label="Reconciled to"
          value={shortDate(row.reconciled_to)}
          sub={row.reconciled_to ? `${row.recon_age_days} days ago` : 'nothing in 6 months'}
          muted={!row.reconciled_to}
        />
        <Frontier
          label="Posted to"
          value={shortDate(row.posted_to)}
          sub={row.posted_to ? `${row.posted_age_days} days ago` : 'nothing in 120 days'}
          muted={!row.posted_to}
        />
        <Frontier
          label="Last touched"
          value={row.touched_at ? shortDate(row.touched_at) : 'Over 30 days'}
          sub={row.touched_at ? 'someone edited the file' : 'nobody has opened it'}
          muted={!row.touched_at}
        />
        <Frontier
          label="Next deadline"
          value={shortDate(row.next_deadline)}
          sub={row.next_deadline ? 'VAT / bookkeeping' : 'none scheduled'}
          muted={!row.next_deadline}
        />
        <Frontier
          label="Uncleared"
          value={row.uncleared_count ?? '—'}
          sub={row.oldest_uncleared ? `oldest ${shortDate(row.oldest_uncleared)}` : null}
        />
        <Frontier
          label="Volume vs normal"
          value={row.volume_ratio != null ? `${Math.round(row.volume_ratio * 100)}%` : '—'}
          sub={row.baseline_monthly ? `normally ~${Math.round(row.baseline_monthly)}/mth` : 'no baseline yet'}
          muted={row.volume_ratio == null}
        />
      </div>

      {/* What the sweep found, in words */}
      {notes.length > 0 && (
        <ul style={{ margin: '0 0 12px', paddingLeft: '18px' }}>
          {notes.map((n, i) => (
            <li key={i} style={{ fontFamily: FONT, fontSize: '12.5px', color: '#475569', marginBottom: '3px' }}>{n}</li>
          ))}
        </ul>
      )}

      {/* Per-account detail — where a single dead feed hides */}
      {live.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: '12px' }}>
          <table style={{ borderCollapse: 'collapse', minWidth: '460px' }}>
            <thead>
              <tr>
                {['Account', 'Last transaction', 'Last reconciled', 'Balance'].map((h) => (
                  <th key={h} style={{
                    fontFamily: FONT, fontSize: '10.5px', color: '#94a3b8', fontWeight: 600,
                    textAlign: h === 'Account' ? 'left' : 'right', padding: '4px 10px', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {live.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontFamily: FONT, fontSize: '12px', padding: '4px 10px', color: '#0f172a' }}>
                    {a.name}
                    {!a.active && (
                      <span style={{ color: '#94a3b8', fontSize: '11px' }}> · dormant</span>
                    )}
                  </td>
                  <td style={{
                    fontFamily: FONT, fontSize: '12px', padding: '4px 10px', textAlign: 'right',
                    color: a.days_since_txn > 45 ? '#c2410c' : '#475569', fontVariantNumeric: 'tabular-nums',
                  }}>
                    {shortDate(a.last_txn)}
                  </td>
                  <td style={{
                    fontFamily: FONT, fontSize: '12px', padding: '4px 10px', textAlign: 'right',
                    color: a.last_reconciled ? '#475569' : '#b91c1c', fontVariantNumeric: 'tabular-nums',
                  }}>
                    {a.last_reconciled ? shortDate(a.last_reconciled) : 'never'}
                  </td>
                  <td style={{
                    fontFamily: FONT, fontSize: '12px', padding: '4px 10px', textAlign: 'right',
                    color: '#475569', fontVariantNumeric: 'tabular-nums',
                  }}>
                    {Number(a.balance || 0).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <span style={{ fontFamily: FONT, fontSize: '10.5px', color: '#94a3b8' }}>Owner</span>
          <select
            value={row.assignee_id || ''}
            disabled={busy}
            onChange={(e) => act(() => onAssign(row, e.target.value || null))}
            style={inputStyle}
          >
            <option value="">Unassigned</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>

        {row.books_owner === 'us' && row.case_id && (
          <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span style={{ fontFamily: FONT, fontSize: '10.5px', color: '#94a3b8' }}>Why is it behind?</span>
              <select value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle}>
                <option value="">Choose a reason…</option>
                {REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span style={{ fontFamily: FONT, fontSize: '10.5px', color: '#94a3b8' }}>Caught up by</span>
              <input type="date" value={promised} onChange={(e) => setPromised(e.target.value)} style={inputStyle} />
            </label>
            <input
              placeholder="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={{ ...inputStyle, minWidth: '180px' }}
            />
            <button
              disabled={!reason || busy}
              onClick={() => act(() => onAcknowledge(row, reason, promised || null, note || null))}
              style={btnPrimary(!reason || busy)}
            >
              Acknowledge
            </button>
            <button disabled={busy} onClick={() => act(() => onDismiss(row))} style={btnGhost}>
              Not drifting
            </button>
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end', marginTop: '10px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <span style={{ fontFamily: FONT, fontSize: '10.5px', color: '#94a3b8' }}>Pause until</span>
          <input type="date" value={pauseUntil} onChange={(e) => setPauseUntil(e.target.value)} style={inputStyle} />
        </label>
        <input
          placeholder="Pause reason"
          value={pauseWhy}
          onChange={(e) => setPauseWhy(e.target.value)}
          style={{ ...inputStyle, minWidth: '180px' }}
        />
        <button
          disabled={!pauseUntil || busy}
          onClick={() => act(() => onPause(row, pauseUntil, pauseWhy))}
          style={btnGhost}
        >
          Pause
        </button>
        {row.paused_until && (
          <button disabled={busy} onClick={() => act(() => onPause(row, null, null))} style={btnGhost}>
            Resume watching
          </button>
        )}
        {canApproveTier && row.tier !== 'standard' && (
          <button disabled={busy} onClick={() => act(() => onTier(row, 'standard', true))} style={btnGhost}>
            Drop to standard
          </button>
        )}
      </div>
    </div>
  );
}

const inputStyle = {
  fontFamily: FONT, fontSize: '12.5px', padding: '6px 9px', borderRadius: '8px',
  border: '1px solid #e2e8f0', backgroundColor: '#fff', color: '#0f172a',
};
const btnGhost = {
  fontFamily: FONT, fontSize: '12.5px', fontWeight: 600, padding: '6px 12px', borderRadius: '8px',
  border: '1px solid #e2e8f0', backgroundColor: '#fff', color: '#475569', cursor: 'pointer',
};
const btnPrimary = (disabled) => ({
  fontFamily: FONT, fontSize: '12.5px', fontWeight: 600, padding: '6px 14px', borderRadius: '8px',
  border: 'none', backgroundColor: disabled ? '#cbd5e1' : '#0ea5e9', color: '#fff',
  cursor: disabled ? 'not-allowed' : 'pointer',
});

/* ── Row ──────────────────────────────────────────────────────── */

function Row({ row, open, onToggle, children }) {
  const tone = STATUS[row.drift_status] || STATUS.unknown;
  const tier = TIER[row.tier] || TIER.standard;
  const over = row.days_over_tolerance;

  return (
    <div style={{ borderBottom: '1px solid #f1f5f9' }}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', cursor: 'pointer',
          backgroundColor: open ? '#f8fafc' : 'transparent',
        }}
      >
        {open ? <ChevronDown size={14} color="#94a3b8" /> : <ChevronRight size={14} color="#94a3b8" />}

        <div style={{ minWidth: 0, flex: '1 1 220px' }}>
          <div style={{
            fontFamily: FONT, fontSize: '13.5px', fontWeight: 600, color: '#0f172a',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {row.entity_name}
          </div>
          <div style={{ fontFamily: FONT, fontSize: '11.5px', color: '#94a3b8' }}>
            {row.frontier_basis === 'posted' ? 'Posted to ' : 'Reconciled to '}
            {row.frontier_basis === 'posted' ? shortDate(row.posted_to) : shortDate(row.reconciled_to)}
            {row.assignee_name ? ` · ${row.assignee_name.split(' ')[0]}` : ' · unassigned'}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {tier.label && (
            <Pill tone={{ ...tier, dot: null }} title="Priority tier">
              <Star size={10} /> {tier.label}
            </Pill>
          )}
          {row.volume_shortfall && (
            <SoftFlag icon={TrendingDown} label="Volume down"
              title={`Running at ${Math.round((row.volume_ratio || 0) * 100)}% of this client's normal monthly volume`} />
          )}
          {row.feed_gap && (
            <SoftFlag icon={Wifi} label="Feed gap"
              title={`${row.longest_gap_90d} silent days — normal for this file is ${row.normal_gap_days}`} />
          )}
          {row.untouched_30d && (
            <SoftFlag icon={Clock} label="Untouched" title="Nobody has posted or edited anything in 30 days" />
          )}
          {row.recon_stuck_21d && row.drift_status !== 'ok' && (
            <SoftFlag icon={AlertTriangle} label="Not moving" title="The reconciliation frontier hasn't advanced in three weeks" />
          )}
          {row.hygiene_score > 0 && (
            <span title={`${row.hygiene_score} hygiene flags`} style={{
              fontFamily: FONT, fontSize: '11px', fontWeight: 600, color: '#64748b',
              backgroundColor: '#f1f5f9', borderRadius: '7px', padding: '2px 7px',
            }}>
              Hygiene {row.hygiene_score}
            </span>
          )}
          {row.case_state === 'acknowledged' && (
            <Pill tone={{ bg: '#eff6ff', border: '#bfdbfe', text: '#1d4ed8', dot: '#3b82f6' }}>
              Acknowledged
            </Pill>
          )}
          <Pill tone={tone}>
            {tone.label}
            {row.drift_status !== 'ok' && row.drift_status !== 'unknown' && row.drift_status !== 'paused'
              && over > 0 ? ` · ${over}d over` : ''}
          </Pill>
        </div>
      </div>
      {open && children}
    </div>
  );
}

/* ── Unlinked-files banner ────────────────────────────────────── */

function LinkPanel({ rows, entities, onLink, onDismiss, onRescan }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const pending = rows.filter((r) => r.review_state !== 'linked' && r.review_state !== 'dismissed');
  if (!pending.length) return null;

  const byState = pending.reduce((acc, r) => { acc[r.review_state] = (acc[r.review_state] || 0) + 1; return acc; }, {});

  return (
    <div style={{ ...card, marginBottom: '14px', borderColor: '#fed7aa', backgroundColor: '#fffbf5' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <Link2 size={16} color="#c2410c" />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: FONT, fontSize: '13.5px', fontWeight: 700, color: '#7c2d12' }}>
            {pending.length} QuickBooks {pending.length === 1 ? 'file is' : 'files are'} not linked to a client
          </div>
          <div style={{ fontFamily: FONT, fontSize: '11.5px', color: '#9a3412' }}>
            They can't be watched until they are.
            {byState.former_client_only ? ` ${byState.former_client_only} match only a former client — worth revoking.` : ''}
          </div>
        </div>
        <button onClick={onRescan} style={btnGhost}><RefreshCw size={12} /> Re-run matcher</button>
        <button onClick={() => setOpen(!open)} style={btnGhost}>{open ? 'Hide' : 'Review'}</button>
      </div>

      {open && (
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {pending.map((r) => (
            <div key={r.realm_id} style={{
              display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
              padding: '8px 10px', backgroundColor: '#fff', borderRadius: '10px', border: '1px solid #f1f5f9',
            }}>
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <div style={{ fontFamily: FONT, fontSize: '13px', fontWeight: 600, color: '#0f172a' }}>
                  {r.company_name}
                </div>
                <div style={{ fontFamily: FONT, fontSize: '11px', color: '#94a3b8' }}>
                  {r.review_state === 'former_client_only' ? 'Only matches a former client'
                    : r.review_state === 'ambiguous' ? 'Several clients share this name'
                    : r.review_state === 'suggested' ? 'One likely match'
                    : 'No match found'}
                </div>
              </div>

              {(r.candidates || []).slice(0, 3).map((c) => (
                <button
                  key={c.entity_id}
                  disabled={busy === r.realm_id}
                  onClick={async () => { setBusy(r.realm_id); await onLink(r.realm_id, c.entity_id); setBusy(null); }}
                  style={{ ...btnGhost, borderColor: c.is_former ? '#fecaca' : '#bbf7d0' }}
                >
                  {c.entity_name}{c.is_former ? ' (former)' : ''}
                </button>
              ))}

              <div style={{ minWidth: '220px' }}>
                <ClientTypeAhead
                  entityList={entities}
                  value={null}
                  size="small"
                  onChange={async (id) => { setBusy(r.realm_id); await onLink(r.realm_id, id); setBusy(null); }}
                />
              </div>

              <button disabled={busy === r.realm_id} onClick={() => onDismiss(r.realm_id)} style={btnGhost}>
                Not a client
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Section ──────────────────────────────────────────────────── */

function Section({ title, subtitle, rows, expanded, setExpanded, detailProps, staff }) {
  const counts = rows.reduce((acc, r) => { acc[r.drift_status] = (acc[r.drift_status] || 0) + 1; return acc; }, {});
  return (
    <div style={{ ...card, padding: 0, marginBottom: '16px', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px',
        borderBottom: '1px solid #f1f5f9',
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: FONT, fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>{title}</div>
          <div style={{ fontFamily: FONT, fontSize: '11.5px', color: '#94a3b8' }}>{subtitle}</div>
        </div>
        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
          {['critical', 'breach', 'watch', 'unknown', 'ok'].map((k) => (
            counts[k] ? <Pill key={k} tone={STATUS[k]}>{counts[k]} {STATUS[k].label.toLowerCase()}</Pill> : null
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: '22px', textAlign: 'center', fontFamily: FONT, fontSize: '13px', color: '#94a3b8' }}>
          Nothing here.
        </div>
      ) : rows.map((r) => (
        <Row
          key={r.entity_id}
          row={r}
          open={expanded === r.entity_id}
          onToggle={() => setExpanded(expanded === r.entity_id ? null : r.entity_id)}
        >
          <DetailPanel row={r} staff={staff} {...detailProps} />
        </Row>
      ))}
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────── */

export default function DriftView() {
  const { profile } = useAuth();
  const [rows, setRows] = useState([]);
  const [links, setLinks] = useState([]);
  const [staff, setStaff] = useState([]);
  const [entities, setEntities] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [error, setError] = useState(null);

  const canApproveTier = profile?.can_approve_bk_priority === true;

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [board, linkRows, staffRows, entRows, cfg] = await Promise.all([
        supabase.from('v_bk_drift_board').select('*'),
        supabase.from('v_bk_realm_link_review').select('*').order('company_name'),
        supabase.from('staff_profiles').select('id, name, is_active').order('name'),
        supabase.from('entities').select('id, name').order('name'),
        supabase.from('bk_drift_settings').select('*').maybeSingle(),
      ]);
      if (board.error) throw board.error;
      setRows(board.data || []);
      setLinks(linkRows.data || []);
      setStaff((staffRows.data || []).filter((s) => s.is_active !== false));
      setEntities(entRows.data || []);
      setSettings(cfg.data || null);
    } catch (e) {
      setError(e.message || 'Could not load the drift board');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  /* Actions */
  const assign = async (row, staffId) => {
    await supabase.from('bk_watch_config').update({ assignee_id: staffId, updated_at: new Date().toISOString() })
      .eq('entity_id', row.entity_id);
    await load();
  };
  const pause = async (row, until, why) => {
    await supabase.from('bk_watch_config').update({
      paused_until: until, pause_reason: why || null,
      paused_by: until ? profile?.id : null, updated_at: new Date().toISOString(),
    }).eq('entity_id', row.entity_id);
    await load();
  };
  const acknowledge = async (row, reason, promisedBy, note) => {
    await supabase.rpc('bk_case_acknowledge', {
      p_case_id: row.case_id, p_reason_code: reason, p_promised_by: promisedBy, p_note: note,
    });
    await load();
  };
  const dismiss = async (row) => {
    if (!window.confirm(`Close the drift case for ${row.entity_name}?\n\nIt reopens if the file is still behind at the next sweep.`)) return;
    await supabase.rpc('bk_case_dismiss', { p_case_id: row.case_id, p_note: null });
    await load();
  };
  const setTier = async (row, tier, accept) => {
    await supabase.rpc('bk_set_tier', { p_entity_id: row.entity_id, p_tier: tier, p_accept: accept });
    await load();
  };
  const linkRealm = async (realmId, entityId) => {
    await supabase.rpc('bk_link_realm', { p_realm_id: realmId, p_entity_id: entityId });
    await supabase.rpc('bk_seed_watch_config');
    await load();
  };
  const dismissRealm = async (realmId) => {
    await supabase.rpc('bk_dismiss_realm', { p_realm_id: realmId, p_dismissed: true });
    await load();
  };
  const rescan = async () => { await supabase.rpc('bk_autolink_realms'); await supabase.rpc('bk_seed_watch_config'); await load(); };

  /* Ordering: worst first, priority tiers pinned above equals. */
  const sorted = useMemo(() => {
    const visible = mineOnly ? rows.filter((r) => r.assignee_id === profile?.id) : rows;
    const tierRank = { critical: 0, priority: 1, standard: 2 };
    return [...visible].sort((a, b) => {
      const sa = (STATUS[a.drift_status] || STATUS.unknown).rank;
      const sb = (STATUS[b.drift_status] || STATUS.unknown).rank;
      if (sa !== sb) return sa - sb;
      const ta = tierRank[a.tier] ?? 2, tb = tierRank[b.tier] ?? 2;
      if (ta !== tb) return ta - tb;
      return (b.days_over_tolerance || 0) - (a.days_over_tolerance || 0);
    });
  }, [rows, mineOnly, profile?.id]);

  const ours = sorted.filter((r) => r.books_owner === 'us');
  const theirs = sorted.filter((r) => r.books_owner !== 'us');
  const suggestions = rows.filter((r) => r.tier_suggested);

  const detailProps = {
    onAssign: assign, onPause: pause, onAcknowledge: acknowledge,
    onDismiss: dismiss, onTier: setTier, canApproveTier,
  };

  if (loading) {
    return <div style={{ padding: '30px', fontFamily: FONT, color: '#94a3b8' }}>Loading the drift board…</div>;
  }

  return (
    <div style={{ padding: '4px 0 30px' }}>
      {error && (
        <div style={{ ...card, marginBottom: '14px', borderColor: '#fecaca', backgroundColor: '#fef2f2' }}>
          <span style={{ fontFamily: FONT, fontSize: '13px', color: '#b91c1c' }}>{error}</span>
        </div>
      )}

      {/* Nudges are built but held. Say so plainly wherever the board is used. */}
      {settings && !settings.nudges_armed && (
        <div style={{ ...card, marginBottom: '14px', borderColor: '#ddd6fe', backgroundColor: '#faf5ff', padding: '10px 14px' }}>
          <span style={{ fontFamily: FONT, fontSize: '12.5px', color: '#6d28d9' }}>
            <strong>Nudges are held.</strong> Cases open and messages queue with their real recipient and wording,
            but nothing is sent until they're armed. Review the queue first.
          </span>
        </div>
      )}

      <LinkPanel
        rows={links}
        entities={entities}
        onLink={linkRealm}
        onDismiss={dismissRealm}
        onRescan={rescan}
      />

      {canApproveTier && suggestions.length > 0 && (
        <div style={{ ...card, marginBottom: '14px', borderColor: '#bfdbfe', backgroundColor: '#f8fbff' }}>
          <div style={{ fontFamily: FONT, fontSize: '13.5px', fontWeight: 700, color: '#1e3a8a', marginBottom: '8px' }}>
            {suggestions.length} priority {suggestions.length === 1 ? 'suggestion' : 'suggestions'} waiting on you
          </div>
          {suggestions.map((s) => (
            <div key={s.entity_id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 0', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: FONT, fontSize: '13px', fontWeight: 600, color: '#0f172a', flex: '1 1 180px' }}>
                {s.entity_name}
              </span>
              <span style={{ fontFamily: FONT, fontSize: '12px', color: '#64748b', flex: '2 1 260px' }}>
                {s.tier_suggested_why}
              </span>
              <button onClick={() => setTier(s, s.tier_suggested, true)} style={btnPrimary(false)}>
                Make {TIER[s.tier_suggested]?.label?.toLowerCase() || s.tier_suggested}
              </button>
              <button onClick={() => setTier(s, null, false)} style={btnGhost}>No</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' }}>
        <button onClick={() => setMineOnly(!mineOnly)} style={{ ...btnGhost, ...(mineOnly ? { borderColor: '#0ea5e9', color: '#0369a1' } : {}) }}>
          {mineOnly ? 'Showing mine' : 'Show only mine'}
        </button>
        <button onClick={load} style={btnGhost}><RefreshCw size={12} /> Refresh</button>
      </div>

      <Section
        title="Ours — we keep these books"
        subtitle="Every row here is somebody's job."
        rows={ours}
        expanded={expanded}
        setExpanded={setExpanded}
        detailProps={detailProps}
        staff={staff}
      />

      <Section
        title="Theirs — the client keeps these books"
        subtitle="Information, not a task list. Red here is a conversation with the client."
        rows={theirs}
        expanded={expanded}
        setExpanded={setExpanded}
        detailProps={detailProps}
        staff={staff}
      />

      <p style={{ fontFamily: FONT, fontSize: '11px', color: '#94a3b8', margin: '4px 2px 0', maxWidth: '760px' }}>
        Transactions still sitting in QuickBooks' bank-feed “For Review” queue are not counted anywhere on this page —
        QuickBooks doesn't expose that queue to the API. Everything here reflects what has been posted. The volume and
        feed-gap flags exist to catch what posting alone can't show.
      </p>
    </div>
  );
}
