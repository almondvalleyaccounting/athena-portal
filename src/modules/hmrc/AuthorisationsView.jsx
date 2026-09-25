import React, { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, RotateCcw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';
import { fmtGbp } from '../../lib/money';
import DataTable from '../../components/DataTable';
import { BTN } from '../../lib/buttonStyles';
import { closeAuthorisation, reopenAuthorisation } from './hmrcApi';
import {
  font, DISENGAGE_REASONS, Pill, Stat, Chip, ErrorBar,
  shortDate, ageLabel, inputStyle,
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
  const [reason, setReasonRaw] = useState('all');
  const [showClosed, setShowClosedRaw] = useState(false);
  const [drafts, setDrafts] = useState({});
  // Sorting is on the column headings. Largest last-known debt first is the
  // order the list always came in (the loader breaks ties by name).
  const [sort, setSort] = useState({ key: 'last_known_debt', dir: 'desc' });
  // Held here, not in the table, so closing a row (which reloads the list)
  // leaves you on the page you were working rather than page 1.
  const [page, setPage] = useState(1);

  // Any change to what is shown starts the list again at page 1.
  const setReason = (v) => { setReasonRaw(v); setPage(1); };
  const setShowClosed = (v) => { setShowClosedRaw(v); setPage(1); };

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      // PostgREST caps a fetch at 1000 rows and truncates SILENTLY, so page
      // through the lot. Same order as fetchAuthorisations, with the id as a
      // unique tiebreak so paging cannot repeat or skip a row.
      setRows(await fetchAllRows(() => supabase
        .from('v_hmrc_authorisation_review')
        .select('*')
        .order('last_known_debt', { ascending: false, nullsFirst: false })
        .order('hmrc_name', { ascending: true })
        .order('id', { ascending: true })));
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

  const columns = [
    {
      key: 'hmrc_name', label: 'Scheme', wrap: true,
      sortValue: (r) => r.hmrc_name || '',
      render: (r) => (
        <>
          <div style={{ fontWeight: 500, color: '#0f172a' }}>{r.hmrc_name}</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 1 }}>
            {r.paye_ref} · {r.service?.toUpperCase()}
          </div>
        </>
      ),
    },
    {
      key: 'reason', label: 'Why', width: 330, wrap: true,
      sortValue: (r) => DISENGAGE_REASONS[r.reason] || r.reason || '',
      render: (r) => (
        <>
          <Pill colour={REASON_COLOUR[r.reason] || '#64748b'}>
            {DISENGAGE_REASONS[r.reason] || r.reason}
          </Pill>
          {r.entity_id && (
            <a href={`/clients/${r.entity_id}`} target="_blank" rel="noreferrer"
               style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#0e7fe0', textDecoration: 'none', marginLeft: 6 }}>
              {r.entity_name} <ExternalLink size={10} />
            </a>
          )}
        </>
      ),
    },
    {
      key: 'last_known_debt', label: 'Last known debt', align: 'right', width: 150, firstDir: 'desc',
      sortValue: (r) => (r.last_known_debt == null ? null : Number(r.last_known_debt)),
      render: (r) => (
        <span style={{ fontVariantNumeric: 'tabular-nums', color: Number(r.last_known_debt) > 0 ? '#b91c1c' : '#cbd5e1', fontWeight: Number(r.last_known_debt) > 0 ? 600 : 400 }}>
          {Number(r.last_known_debt) > 0 ? fmtGbp(r.last_known_debt) : '—'}
        </span>
      ),
    },
    {
      // Longest outstanding first on the first click.
      key: 'days_outstanding', label: 'Flagged', width: 120, firstDir: 'desc',
      sortValue: (r) => (r.days_outstanding == null ? null : Number(r.days_outstanding)),
      render: (r) => (
        <span style={{ fontSize: 13, color: '#64748b' }}
              title={`First flagged ${shortDate(r.first_flagged)}, last seen on the agent list ${shortDate(r.last_seen_on_list)}`}>
          {ageLabel(r.days_outstanding)} ago
        </span>
      ),
    },
    {
      // Closed rows sort by when they were closed; open rows by the saved
      // note. A draft being typed is not in the rows, so it never re-sorts.
      key: 'note', label: showClosed ? 'Closed' : 'Note', width: 260, wrap: true,
      firstDir: showClosed ? 'desc' : 'asc',
      sortValue: (r) => (showClosed ? r.removed_at : r.note) || '',
      render: (r) => (showClosed ? (
        <div style={{ fontSize: 13, color: '#64748b' }}>
          {shortDate(r.removed_at)}{r.removed_by ? ` · ${r.removed_by}` : ''}
          {r.note && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{r.note}</div>}
        </div>
      ) : (
        <input
          value={drafts[r.id] ?? (r.note || '')}
          onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
          placeholder="Handed back? Or record fixed?"
          style={inputStyle}
        />
      )),
    },
    {
      key: 'actions', label: '', width: 120, sortable: false,
      render: (r) => (showClosed ? (
        <button onClick={() => reopen(r)} style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                title="Put this back on the outstanding list">
          <RotateCcw size={12} /> Reopen
        </button>
      ) : (
        <button onClick={() => close(r)} style={btn('#059669', '#f0fdf4', '#05966933')}
                title="Record that this authorisation has been dealt with">
          <Check size={12} /> Done
        </button>
      )),
    },
  ];

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 14, color: '#64748b', maxWidth: 860, marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
        Schemes we&rsquo;re agent for with no active client. Hand back or fix the client, then note which.
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#64748b', fontFamily: font, cursor: 'pointer' }}>
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show closed ({rows.length - openRows.length})
        </label>
      </div>

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 14, padding: 24 }}>Loading authorisation reviews…</div>
      ) : (
        // Keeps a minimum width and scrolls sideways on a narrow screen rather
        // than squashing the note field.
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 1100 }}>
            <DataTable
              columns={columns}
              rows={visible}
              rowKey={(r) => r.id}
              sort={sort}
              onSort={(s) => { setSort(s); setPage(1); }}
              page={page}
              onPage={setPage}
              empty={showClosed ? 'Nothing closed yet.' : 'No authorisations outstanding.'}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function btn(colour, bg, border) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
    fontSize: 13, fontFamily: font, borderRadius: 7, cursor: 'pointer',
    color: colour, background: bg, border: `1px solid ${border}`,
  };
}
