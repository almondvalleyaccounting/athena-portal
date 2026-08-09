import React, { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, RotateCcw } from 'lucide-react';
import { fetchExceptions, setExceptionResolved, setExceptionNote } from './hmrcApi';
import {
  font, EXCEPTION_KINDS, Pill, Chip, BlurInput, ErrorBar,
  shortDate, th, td, card, inputStyle,
} from './hmrcShared';

// Where the HMRC agent list and Athena disagree.
//
// This is the tab that keeps the debt figures honest: a scheme HMRC shows us as
// agent for but Athena has never heard of is either a missing client or a
// missing PAYE reference, and until it is one or the other the totals on the
// Debt tab are understated. Resolving a row here does not change HMRC — it
// records that a human has dealt with it, so the next scrape's list is only
// the new problems.

export default function ReconcileView() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kind, setKind] = useState('all');
  const [showResolved, setShowResolved] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      setRows(await fetchExceptions());
      setError('');
    } catch (e) {
      setError(e.message || 'Could not load reconciliation exceptions');
    } finally {
      setLoading(false);
    }
  }

  async function toggleResolved(row) {
    const next = !row.resolved;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, resolved: next } : r)));
    try {
      await setExceptionResolved(row.id, next);
      setError('');
    } catch (e) {
      setError(e.message || 'Could not save');
      load();
    }
  }

  async function saveNote(row, note) {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, note } : r)));
    try {
      await setExceptionNote(row.id, note);
      setError('');
    } catch (e) {
      setError(e.message || 'Could not save note');
      load();
    }
  }

  const visible = useMemo(
    () => rows.filter((r) => r.resolved === showResolved && (kind === 'all' || r.kind === kind)),
    [rows, kind, showResolved],
  );

  const open = rows.filter((r) => !r.resolved);
  const kindCounts = open.reduce((acc, r) => { acc[r.kind] = (acc[r.kind] || 0) + 1; return acc; }, {});
  const kinds = Object.keys(EXCEPTION_KINDS).filter((k) => kindCounts[k]);

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 860, marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
        Every place the HMRC agent list and Athena disagree. Until these are cleared the debt totals are
        incomplete — a scheme Athena has never heard of contributes nothing to the numbers on the Debt tab.
        Tick a row off once you have fixed the underlying record; the next scrape only re-raises what is
        still wrong.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip value="all" label="All" count={open.length} active={kind} onClick={setKind} />
        {kinds.map((k) => (
          <Chip
            key={k}
            value={k}
            label={EXCEPTION_KINDS[k].label}
            count={kindCounts[k]}
            active={kind}
            onClick={setKind}
            colour={EXCEPTION_KINDS[k].colour}
          />
        ))}
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b', fontFamily: font, cursor: 'pointer' }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show cleared ({rows.length - open.length})
        </label>
      </div>

      {kind !== 'all' && EXCEPTION_KINDS[kind] && (
        <div style={{
          fontSize: 12, color: '#475569', background: '#f8fafc', border: '1px solid #e5e7eb',
          borderRadius: 8, padding: '8px 12px', marginBottom: 12, lineHeight: 1.5,
        }}>
          {EXCEPTION_KINDS[kind].hint}
        </div>
      )}

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading exceptions…</div>
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
                  <th style={th}>Kind</th>
                  <th style={th}>Scheme</th>
                  <th style={th}>Athena</th>
                  <th style={th}>HMRC</th>
                  <th style={th}>Note</th>
                  <th style={th}>Raised</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                      {showResolved ? 'Nothing cleared yet.' : 'Nothing outstanding — HMRC and Athena agree.'}
                    </td>
                  </tr>
                )}
                {visible.map((r) => {
                  const meta = EXCEPTION_KINDS[r.kind] || { label: r.kind, colour: '#64748b', hint: '' };
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>
                        <Pill colour={meta.colour} title={meta.hint}>{meta.label}</Pill>
                      </td>
                      <td style={td}>
                        <div style={{ fontWeight: 500, color: '#0f172a' }}>{r.hmrc_name}</div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{r.paye_ref}</div>
                      </td>
                      <td style={{ ...td, fontSize: 12 }}>
                        {r.entity_id ? (
                          <a href={`/clients/${r.entity_id}`} target="_blank" rel="noreferrer"
                             style={{ color: '#0e7fe0', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {r.entity_name || 'Open'} <ExternalLink size={11} />
                          </a>
                        ) : r.suggested_entity_id ? (
                          // Normalised-name match from the view. It is a lead,
                          // not a link — the actual fix is keying the PAYE ref
                          // onto the client record.
                          <div>
                            <div style={{ fontSize: 10, color: '#94a3b8' }}>Possible match</div>
                            <a href={`/clients/${r.suggested_entity_id}`} target="_blank" rel="noreferrer"
                               style={{ color: '#7c3aed', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              {r.suggested_entity_name} <ExternalLink size={11} />
                            </a>
                            {r.suggested_entity_status && r.suggested_entity_status !== 'active' && (
                              <span style={{ fontSize: 10, color: '#c2410c', marginLeft: 5 }}>({r.suggested_entity_status})</span>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: '#cbd5e1' }}>No match</span>
                        )}
                      </td>
                      <td style={{ ...td, fontSize: 12, color: '#64748b', maxWidth: 160 }}>
                        {r.hmrc_value || '—'}
                        {r.athena_value && r.athena_value !== r.hmrc_value && (
                          <div style={{ fontSize: 11, color: '#c2410c', marginTop: 2 }}>Athena: {r.athena_value}</div>
                        )}
                      </td>
                      {/* One note field, seeded by the scraper with why it
                          raised the row, then overwritten by whoever works it.
                          Editing replaces the scraper's text — that is fine,
                          the kind and its tooltip already carry the reason. */}
                      <td style={{ ...td, minWidth: 220 }}>
                        <BlurInput value={r.note} onChange={(v) => saveNote(r, v)} placeholder="What did you find?" />
                      </td>
                      <td style={{ ...td, fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>{shortDate(r.raised_at)}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <button
                          onClick={() => toggleResolved(r)}
                          title={r.resolved ? 'Put this back on the outstanding list' : 'Mark as dealt with'}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
                            fontSize: 12, fontFamily: font, borderRadius: 7, cursor: 'pointer',
                            color: r.resolved ? '#64748b' : '#059669',
                            background: r.resolved ? '#f8fafc' : '#f0fdf4',
                            border: `1px solid ${r.resolved ? '#e5e7eb' : '#05966933'}`,
                          }}
                        >
                          {r.resolved ? <><RotateCcw size={12} /> Reopen</> : <><Check size={12} /> Clear</>}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
