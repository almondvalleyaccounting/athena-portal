import React, { useState, useRef } from 'react';
import { supabase } from '../../../lib/supabase';

const font = "'Outfit', sans-serif";

export default function CompaniesHouseView() {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [remaining, setRemaining] = useState(null);
  const [errors, setErrors] = useState([]);
  const [message, setMessage] = useState('');
  const stopRef = useRef(false);

  async function callOnce(force = false) {
    const session = (await supabase.auth.getSession()).data.session;
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ch-ingest-officers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token ?? ''}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 20, force }),
      }
    );
    return res.json();
  }

  async function runLoop(force) {
    setRunning(true);
    setDone(0);
    setRemaining(null);
    setErrors([]);
    setMessage('');
    stopRef.current = false;
    let total = 0;
    try {
      while (!stopRef.current) {
        const r = await callOnce(force);
        if (r.error) { setMessage(`Error: ${r.error}`); break; }
        total += r.processed || 0;
        setDone(total);
        setRemaining(r.total_remaining ?? 0);
        if (r.errors && r.errors.length) {
          setErrors((prev) => [...prev, ...r.errors]);
          if (r.errors.some((e) => e.error === 'rate_limited')) {
            setMessage('Rate-limited — pausing 60s before resuming…');
            await new Promise((res) => setTimeout(res, 60000));
            continue;
          }
        }
        if (!r.processed || (r.total_remaining ?? 0) === 0) break;
      }
      setMessage(stopRef.current ? 'Stopped.' : 'Done.');
    } catch (e) {
      setMessage(`Error: ${e.message || e}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ padding: '24px 28px', fontFamily: font, maxWidth: 900 }}>
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24 }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', margin: 0 }}>
          Companies House sync
        </h2>
        <p style={{ fontSize: 13, color: '#64748b', margin: '8px 0 20px' }}>
          Pulls active officers (directors, secretaries) and individual PSCs (shareholders ≥ 25%)
          from Companies House for every limited-company client. Powers the client-group view in
          the Allocations matrix. Requires <code>CH_API_KEY</code> set in Supabase function secrets.
        </p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => runLoop(false)}
            disabled={running}
            style={{
              fontFamily: font, fontSize: 13, fontWeight: 600,
              color: '#fff', background: '#0f172a', border: 'none', borderRadius: 10,
              padding: '10px 18px', cursor: running ? 'wait' : 'pointer',
              opacity: running ? 0.6 : 1,
            }}
          >
            {running ? 'Syncing…' : 'Sync new only'}
          </button>
          <button
            onClick={() => runLoop(true)}
            disabled={running}
            title="Re-ingest every limited company, including ones already loaded"
            style={{
              fontFamily: font, fontSize: 13, fontWeight: 500,
              color: '#64748b', background: '#fff', border: '1px solid #cbd5e1',
              borderRadius: 10, padding: '10px 18px', cursor: running ? 'wait' : 'pointer',
              opacity: running ? 0.6 : 1,
            }}
          >
            Re-sync all
          </button>
          {running && (
            <button
              onClick={() => { stopRef.current = true; }}
              style={{
                fontFamily: font, fontSize: 13,
                color: '#b91c1c', background: '#fff', border: '1px solid #fca5a5',
                borderRadius: 10, padding: '10px 18px', cursor: 'pointer',
              }}
            >Stop</button>
          )}
        </div>

        {(running || done > 0 || message) && (
          <div style={{ marginTop: 20, fontSize: 13, color: '#475569' }}>
            <strong>{done}</strong> processed · <strong>{remaining ?? '?'}</strong> remaining{message && ` · ${message}`}
          </div>
        )}

        {errors.length > 0 && (
          <details style={{ marginTop: 16, fontSize: 12, color: '#b91c1c' }}>
            <summary style={{ cursor: 'pointer' }}>{errors.length} error{errors.length === 1 ? '' : 's'}</summary>
            <ul style={{ marginTop: 8, paddingLeft: 20 }}>
              {errors.slice(0, 50).map((e, i) => (
                <li key={i}>{e.name}: {e.error}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
