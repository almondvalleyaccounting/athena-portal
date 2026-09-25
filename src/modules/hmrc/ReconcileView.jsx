import React, { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, RotateCcw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';
import DataTable from '../../components/DataTable';
import { BTN } from '../../lib/buttonStyles';
import { setExceptionResolved, setExceptionNote } from './hmrcApi';
import {
  font, EXCEPTION_KINDS, Pill, Chip, BlurInput, ErrorBar,
  shortDate,
} from './hmrcShared';

// Where the HMRC agent list and Athena disagree.
//
// This is the tab that keeps the debt figures honest: a scheme HMRC shows us as
// agent for but Athena has never heard of is either a missing client or a
// missing PAYE reference, and until it is one or the other the totals on the
// Debt tab are understated. Resolving a row here does not change HMRC — it
// records that a human has dealt with it, so the next scrape's list is only
// the new problems.

const kindMeta = (r) => EXCEPTION_KINDS[r.kind] || { label: r.kind, colour: '#64748b', hint: '' };

export default function ReconcileView() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kind, setKindRaw] = useState('all');
  const [showResolved, setShowResolvedRaw] = useState(false);
  // Sorting is on the column headings. By kind is the order the list always
  // came in (the loader breaks ties by HMRC name).
  const [sort, setSort] = useState({ key: 'kind', dir: 'asc' });
  // Held here, not in the table, so clearing a row (which drops it out of the
  // list) leaves you on the page you were working rather than page 1.
  const [page, setPage] = useState(1);

  // Any change to what is shown starts the list again at page 1.
  const setKind = (v) => { setKindRaw(v); setPage(1); };
  const setShowResolved = (v) => { setShowResolvedRaw(v); setPage(1); };

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      // PostgREST caps a fetch at 1000 rows and truncates SILENTLY, so page
      // through the lot. Same order as fetchExceptions, with the id as a
      // unique tiebreak so paging cannot repeat or skip a row.
      setRows(await fetchAllRows(() => supabase
        .from('v_hmrc_link_exceptions')
        .select('*')
        .order('kind', { ascending: true })
        .order('hmrc_name', { ascending: true })
        .order('id', { ascending: true })));
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

  const columns = [
    {
      key: 'kind', label: 'Kind', width: 210,
      sortValue: (r) => r.kind || '',
      render: (r) => {
        const meta = kindMeta(r);
        return <Pill colour={meta.colour} title={meta.hint}>{meta.label}</Pill>;
      },
    },
    {
      key: 'hmrc_name', label: 'Scheme', wrap: true,
      sortValue: (r) => r.hmrc_name || '',
      render: (r) => (
        <>
          <div style={{ fontWeight: 500, color: '#0f172a' }}>{r.hmrc_name}</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 1 }}>{r.paye_ref}</div>
        </>
      ),
    },
    {
      key: 'athena', label: 'Athena', width: 230, wrap: true,
      sortValue: (r) => (r.entity_id ? (r.entity_name || 'Open') : (r.suggested_entity_name || '')),
      render: (r) => (
        <span style={{ fontSize: 13 }}>
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
              <div style={{ fontSize: 11, color: '#94a3b8' }}>Possible match</div>
              <a href={`/clients/${r.suggested_entity_id}`} target="_blank" rel="noreferrer"
                 style={{ color: '#7c3aed', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {r.suggested_entity_name} <ExternalLink size={11} />
              </a>
              {r.suggested_entity_status && r.suggested_entity_status !== 'active' && (
                <span style={{ fontSize: 11, color: '#c2410c', marginLeft: 5 }}>({r.suggested_entity_status})</span>
              )}
            </div>
          ) : (
            <span style={{ color: '#cbd5e1' }}>No match</span>
          )}
        </span>
      ),
    },
    {
      key: 'hmrc_value', label: 'HMRC', width: 170, wrap: true,
      sortValue: (r) => r.hmrc_value || '',
      render: (r) => (
        <div style={{ fontSize: 13, color: '#64748b' }}>
          {r.hmrc_value || '—'}
          {r.athena_value && r.athena_value !== r.hmrc_value && (
            <div style={{ fontSize: 12, color: '#c2410c', marginTop: 2 }}>Athena: {r.athena_value}</div>
          )}
        </div>
      ),
    },
    {
      // One note field, seeded by the scraper with why it raised the row,
      // then overwritten by whoever works it. Editing replaces the scraper's
      // text — that is fine, the kind and its tooltip already carry the
      // reason. BlurInput saves on blur, so the list cannot re-sort under a
      // note while it is still being typed.
      key: 'note', label: 'Note', width: 240,
      sortValue: (r) => r.note || '',
      render: (r) => (
        <BlurInput value={r.note} onChange={(v) => saveNote(r, v)} placeholder="What did you find?" />
      ),
    },
    {
      key: 'raised_at', label: 'Raised', width: 120, firstDir: 'desc',
      sortValue: (r) => r.raised_at || '',
      render: (r) => <span style={{ fontSize: 13, color: '#94a3b8' }}>{shortDate(r.raised_at)}</span>,
    },
    {
      key: 'actions', label: '', width: 120, sortable: false,
      render: (r) => (
        <button
          onClick={() => toggleResolved(r)}
          title={r.resolved ? 'Put this back on the outstanding list' : 'Mark as dealt with'}
          style={r.resolved
            ? { ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 5 }
            : {
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
              fontSize: 13, fontFamily: font, borderRadius: 7, cursor: 'pointer',
              color: '#059669', background: '#f0fdf4', border: '1px solid #05966933',
            }}
        >
          {r.resolved ? <><RotateCcw size={12} /> Reopen</> : <><Check size={12} /> Clear</>}
        </button>
      ),
    },
  ];

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 14, color: '#64748b', maxWidth: 860, marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
        Where HMRC&rsquo;s agent list and Athena disagree. Fix the record, then tick it off.
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#64748b', fontFamily: font, cursor: 'pointer' }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show cleared ({rows.length - open.length})
        </label>
      </div>

      {kind !== 'all' && EXCEPTION_KINDS[kind] && (
        <div style={{
          fontSize: 13, color: '#475569', background: '#f8fafc', border: '1px solid #e5e7eb',
          borderRadius: 8, padding: '8px 12px', marginBottom: 12, lineHeight: 1.5,
        }}>
          {EXCEPTION_KINDS[kind].hint}
        </div>
      )}

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 14, padding: 24 }}>Loading exceptions…</div>
      ) : (
        // Keeps a minimum width and scrolls sideways on a narrow screen rather
        // than squashing the note field.
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 1250 }}>
            <DataTable
              columns={columns}
              rows={visible}
              rowKey={(r) => r.id}
              sort={sort}
              onSort={(s) => { setSort(s); setPage(1); }}
              page={page}
              onPage={setPage}
              empty={showResolved ? 'Nothing cleared yet.' : 'Nothing outstanding — HMRC and Athena agree.'}
            />
          </div>
        </div>
      )}
    </div>
  );
}
