import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Clock, Check, X } from 'lucide-react';
import { font, Pill, dateTime } from './hmrcShared';
import { requestRefresh, fetchRefreshQueue, cancelRefresh } from './hmrcApi';

// "Ask HMRC again" for one client.
//
// This is a REQUEST, not a fetch, and the button says so. A scrape needs a live
// Government Gateway session — a person, plus an access code from a second device
// — so Athena cannot start one. It writes to a queue that the scraper drains with
// `npm run refresh` next time somebody is signed in. Showing a spinner would be a
// lie; showing "waiting for a signed-in session" is the truth and sets the right
// expectation.
//
// Why per-client refresh exists at all: the sweep is monthly, but CIS credits
// land, HMRC reallocates payments between taxes, and Employment Allowance gets
// claimed back-dated. When somebody is on the phone to a client about a balance,
// waiting for the next sweep is too long.

const ALL = ['paye', 'corporation-tax', 'vat', 'self-assessment'];

const LABEL = {
  'paye': 'PAYE',
  'corporation-tax': 'Corporation Tax',
  'vat': 'VAT',
  'self-assessment': 'Self Assessment',
};

export default function RefreshButton({ entityId, services = ALL, compact = false, onQueued }) {
  const [queue, setQueue] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!entityId) return;
    fetchRefreshQueue(entityId)
      .then(setQueue)
      // Never break the page this sits on over the state of a queue.
      .catch(() => setQueue([]));
  }, [entityId]);

  useEffect(() => { setResult(null); setError(''); load(); }, [entityId, load]);

  const ask = async () => {
    setBusy(true);
    setError('');
    try {
      const rows = await requestRefresh(entityId, services, 'requested from Athena');
      setResult(rows);
      load();
      if (onQueued) onQueued(rows);
    } catch (e) {
      setError(e.message || 'Could not queue the refresh');
    } finally {
      setBusy(false);
    }
  };

  const drop = async (id) => {
    try {
      const ok = await cancelRefresh(id);
      // false means the scraper picked it up between render and click. Reloading
      // shows it as running rather than claiming a cancel that did not happen.
      if (!ok) setError('That one had already started — it cannot be stopped from here.');
      load();
    } catch (e) {
      setError(e.message || 'Could not cancel');
    }
  };

  if (!entityId) return null;

  const waiting = queue.filter((q) => q.status === 'pending');
  const running = queue.filter((q) => q.status === 'running');

  return (
    <div style={{ fontFamily: font, display: 'inline-block' }}>
      <button
        onClick={ask}
        disabled={busy}
        title="Queue a re-scrape of this client at HMRC. It runs next time somebody is signed in to the agent portal."
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: compact ? 11.5 : 12, fontWeight: 600, fontFamily: font,
          color: '#0e7fe0', background: '#fff', border: '1px solid #bfdbfe',
          borderRadius: 7, padding: compact ? '4px 8px' : '6px 11px',
          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
        }}
      >
        <RefreshCw size={12} />
        {busy ? 'Asking…' : 'Ask HMRC again'}
      </button>

      {(waiting.length > 0 || running.length > 0) && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8, flexWrap: 'wrap' }}>
          <Clock size={11} style={{ color: '#c2410c' }} />
          <span style={{ fontSize: 11.5, color: '#c2410c' }}>
            {running.length > 0
              ? `${running.map((r) => LABEL[r.service] || r.service).join(', ')} running now`
              : `Waiting for a signed-in HMRC session: ${waiting.map((r) => LABEL[r.service] || r.service).join(', ')}`}
          </span>
          {waiting.map((r) => (
            <button key={r.id} onClick={() => drop(r.id)} title={`Requested ${dateTime(r.requested_at)}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontFamily: font,
                color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}>
              <X size={9} /> cancel {LABEL[r.service] || r.service}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 11.5, color: '#b91c1c', marginTop: 5 }}>{error}</div>
      )}

      {result && <Outcome rows={result} />}
    </div>
  );
}

// What the request actually did, per tax. Worth spelling out: "no reference held"
// is a fact about the client, not a failure, and a client with two PAYE schemes
// only gets one of them refreshed — both are things you want to know now rather
// than wonder about later.
function Outcome({ rows }) {
  const by = (state) => rows.filter((r) => r.state === state).map((r) => LABEL[r.service] || r.service);
  const queued = by('queued');
  const already = by('already-queued');
  const missing = by('no-reference');
  const second = rows.filter((r) => r.state === 'second-scheme');

  return (
    <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {queued.length > 0 && (
        <div style={{ fontSize: 11.5, color: '#166534', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Check size={11} /> Queued {queued.join(', ')} — runs next time somebody signs in to HMRC.
        </div>
      )}
      {already.length > 0 && (
        <div style={{ fontSize: 11.5, color: '#64748b' }}>
          {already.join(', ')} {already.length === 1 ? 'was' : 'were'} already waiting — not asked twice.
        </div>
      )}
      {missing.length > 0 && (
        <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
          No reference held for {missing.join(', ')}, so there is nothing to ask about.
        </div>
      )}
      {second.map((r) => (
        <div key={r.reference} style={{ fontSize: 11.5, color: '#c2410c' }}>
          <Pill colour="#c2410c" bg="#fff7ed" style={{ fontSize: 9.5 }}>Second scheme</Pill>{' '}
          PAYE {r.reference} is not included — the queue holds one scheme per client,
          so this one refreshes on the monthly sweep.
        </div>
      ))}
    </div>
  );
}
