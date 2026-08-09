import React, { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, RotateCcw } from 'lucide-react';
import { fmtGbp } from '../../lib/money';
import { fetchAuthorisations, closeAuthorisation, reopenAuthorisation } from './hmrcApi';
import {
  font, DISENGAGE_REASONS, Pill, Stat, Chip, ErrorBar,
  shortDate, ageLabel, th, td, thNum, tdNum, card, inputStyle,
} from './hmrcShared';

// Schemes we still hold HMRC authorisation for, with no active Athena client
// behind them.
//
// This matters for two reasons that pull in opposite directions: an
// authorisation we should have handed back is a liability (we can still see and
// be assumed responsible for a scheme we do not act for), and an authorisation
// we should NOT hand back means the client record is wrong. So closing a row
// asks for a note — "handed back" and "actually still ours, record fixed" are
// both valid outcomes and the difference is worth keeping.

const REASON_COLOUR = {
  no_athena_record: '#b91c1c',
  archived: '#c2410c',
  nlac: '#7c3aed',
};

export default function AuthorisationsView() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('all');
  const [showClosed, setShowClosed] = useState(false);
  const [drafts, setDrafts] = useState({});

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      setRows(await fetchAuthorisations());
      setError('');
    } catch (e) {
      setError(e.message || 'Could not load authorisation reviews');
    } finally {
      setLoading(false);
    }
  }

  async function close(row) {
    const note = drafts[row.id] || '';
    try {
      await closeAuthorisation(row.id, note);
      setDrafts((d) => { const n = { ...d }; delete n[row.id]; return n; });
      await load();
    } catch (e) {
      setError(e.message || 'Could not close this review');
    }
  }

  async function reopen(row) {
    try {
      await reopenAuthorisation(row.id);
      await load();
    } catch (e) {
      setError(e.message || 'Could not reopen this review');
    }
  }

  const openRows = rows.filter((r) => !r.removed_at);
  const visible = useMemo(
    () => rows
      .filter((r) => (showClosed ? !!r.removed_at : !r.removed_at))
      .filter((r) => reason === 'all' || r.reason === reason),
    [rows, reason, showClosed],
  );

  const reasonCounts = openRows.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {});
  const withDebt = openRows.filter((r) => Number(r.last_known_debt) > 0);

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 860, marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
        Schemes HMRC still shows us as agent for, with no active client behind them. Each one is either an
        authorisation to hand back, or a client record that needs correcting. Closing a row records that
        someone dealt with it — add a note saying which, because the two outcomes look identical afterwards.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16, maxWidth: 760 }}>
        <Stat label="Open reviews" value={openRows.length} colour="#c2410c" big />
        <Stat label="No Athena record" value={reasonCounts.no_athena_record || 0} colour="#b91c1c"
              hint="HMRC knows them, we do not" />
        <Stat label="Former clients" value={(reasonCounts.archived || 0) + (reasonCounts.nlac || 0)} colour="#7c3aed"
              hint="Archived or marked no longer a client" />
        <Stat label="Carrying debt" value={withDebt.length} colour="#0369a1"
              hint={withDebt.length ? `${fmtGbp(withDebt.reduce((s, r) => s + Number(r.last_known_debt || 0), 0))} last known` : 'None owe anything'} />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip value="all" label="All reasons" count={openRows.length} active={reason} onClick={setReason} />
        {Object.keys(DISENGAGE_REASONS).filter((k) => reasonCounts[k]).map((k) => (
          <Chip key={k} value={k} label={DISENGAGE_REASONS[k]} count={reasonCounts[k]}
                active={reason} onClick={setReason} colour={REASON_COLOUR[k]} />
        ))}
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b', fontFamily: font, cursor: 'pointer' }}>
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show closed ({rows.length - openRows.length})
        </label>
      </div>

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading authorisation reviews…</div>
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
                  <th style={th}>Scheme</th>
                  <th style={th}>Why</th>
                  <th style={thNum}>Last known debt</th>
                  <th style={th}>Flagged</th>
                  <th style={th}>{showClosed ? 'Closed' : 'Note'}</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                      {showClosed ? 'Nothing closed yet.' : 'No authorisations outstanding.'}
                    </td>
                  </tr>
                )}
                {visible.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      <div style={{ fontWeight: 500, color: '#0f172a' }}>{r.hmrc_name}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>
                        {r.paye_ref} · {r.service?.toUpperCase()}
                      </div>
                    </td>
                    <td style={td}>
                      <Pill colour={REASON_COLOUR[r.reason] || '#64748b'}>
                        {DISENGAGE_REASONS[r.reason] || r.reason}
                      </Pill>
                      {r.entity_id && (
                        <a href={`/clients/${r.entity_id}`} target="_blank" rel="noreferrer"
                           style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#0e7fe0', textDecoration: 'none', marginLeft: 6 }}>
                          {r.entity_name} <ExternalLink size={10} />
                        </a>
                      )}
                    </td>
                    <td style={{ ...tdNum, color: Number(r.last_known_debt) > 0 ? '#b91c1c' : '#cbd5e1', fontWeight: Number(r.last_known_debt) > 0 ? 600 : 400 }}>
                      {Number(r.last_known_debt) > 0 ? fmtGbp(r.last_known_debt) : '—'}
                    </td>
                    <td style={{ ...td, fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}
                        title={`First flagged ${shortDate(r.first_flagged)}, last seen on the agent list ${shortDate(r.last_seen_on_list)}`}>
                      {ageLabel(r.days_outstanding)} ago
                    </td>
                    <td style={{ ...td, minWidth: 200 }}>
                      {showClosed ? (
                        <div style={{ fontSize: 12, color: '#64748b' }}>
                          {shortDate(r.removed_at)}{r.removed_by ? ` · ${r.removed_by}` : ''}
                          {r.note && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{r.note}</div>}
                        </div>
                      ) : (
                        <input
                          value={drafts[r.id] ?? (r.note || '')}
                          onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                          placeholder="Handed back? Or record fixed?"
                          style={inputStyle}
                        />
                      )}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {showClosed ? (
                        <button onClick={() => reopen(r)} style={btn('#64748b', '#f8fafc', '#e5e7eb')}
                                title="Put this back on the outstanding list">
                          <RotateCcw size={12} /> Reopen
                        </button>
                      ) : (
                        <button onClick={() => close(r)} style={btn('#059669', '#f0fdf4', '#05966933')}
                                title="Record that this authorisation has been dealt with">
                          <Check size={12} /> Done
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function btn(colour, bg, border) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
    fontSize: 12, fontFamily: font, borderRadius: 7, cursor: 'pointer',
    color: colour, background: bg, border: `1px solid ${border}`,
  };
}
