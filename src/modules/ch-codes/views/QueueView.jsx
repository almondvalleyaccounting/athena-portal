import React, { useEffect, useMemo, useState } from 'react';
import { Send, Trash2, ChevronDown, ChevronRight, Check, AlertTriangle } from 'lucide-react';
import { Btn } from '../../../components/ui';
import { chipStyle, tones } from '../../../lib/tokens';
import ChSubNav from '../components/ChSubNav';
import { listQueue, cancelQueued, sendQueue, QUEUE_KINDS } from '../api';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };

const KIND_TONE = { offer: 'info', reminder: 'warning', id_poa: 'accent', code: 'success' };

export default function QueueView() {
  const [queued, setQueued] = useState(null);
  const [recent, setRecent] = useState([]);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = () => Promise.all([listQueue('queued'), listQueue('sent'), listQueue('failed')])
    .then(([q, sent, failed]) => {
      setQueued(q);
      setRecent([...failed, ...sent].sort((a, b) => new Date(b.sent_at || b.created_at) - new Date(a.sent_at || a.created_at)).slice(0, 25));
    })
    .catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);

  const totalQueued = queued?.length || 0;

  async function remove(id) {
    setBusyId(id); setError(null);
    try { await cancelQueued(id); await load(); } catch (e) { setError(e.message); }
    setBusyId(null);
  }

  async function sendAll(ids) {
    setSending(true); setError(null); setResult(null);
    try {
      const res = await sendQueue(ids);
      setResult(res);
      await load();
    } catch (e) { setError(e.message); }
    setSending(false);
  }

  function Row({ item, sent }) {
    const open = openId === item.id;
    const tone = KIND_TONE[item.kind] || 'neutral';
    return (
      <div style={{ borderTop: '1px solid #f1f5f9' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px' }}>
          <button
            onClick={() => setOpenId(open ? null : item.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 0, display: 'flex' }}
          >
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          <div style={{ flex: '1 1 200px', minWidth: 180 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>{item.request?.person?.name || '—'}</div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>{item.request?.entity?.name || ''} · {item.to_email}</div>
          </div>
          <span style={chipStyle(tone)}>{QUEUE_KINDS[item.kind] || item.kind}</span>
          <div style={{ flex: '2 1 220px', fontSize: 12.5, color: '#475569', minWidth: 160 }}>{item.subject}</div>
          {sent ? (
            item.status === 'failed'
              ? <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={10} /> failed</span>
              : <span style={{ ...chipStyle('success'), display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={10} /> sent</span>
          ) : (
            <button
              onClick={() => remove(item.id)}
              disabled={busyId === item.id}
              title="Remove from queue"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#fff', border: `1px solid ${tones.danger.border}`, color: tones.danger.fg, borderRadius: 8, padding: '5px 9px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: font }}
            >
              <Trash2 size={12} /> Remove
            </button>
          )}
        </div>
        {open && (
          <div style={{ padding: '0 16px 14px 44px' }}>
            {item.error && <div style={{ color: tones.danger.fg, fontSize: 12, marginBottom: 8 }}>Error: {item.error}</div>}
            <iframe
              title={`preview-${item.id}`}
              srcDoc={item.html}
              style={{ width: '100%', height: 360, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fafafa' }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Email queue</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            Review everything queued from the tiles, then send it all in one go. Nothing leaves until you press Send.
          </p>
        </div>
        <ChSubNav active="Queue" queuedCount={totalQueued} />
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 13, marginBottom: 12 }}>Failed: {error}</div>}
      {result && (
        <div style={{ background: result.failed ? tones.warning.bg : tones.success.bg, color: result.failed ? tones.warning.fg : tones.success.fg, borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>
          Sent {result.sent} email{result.sent === 1 ? '' : 's'}{result.failed ? `, ${result.failed} failed (see below)` : ''}.
        </div>
      )}

      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: totalQueued ? '1px solid #f1f5f9' : 'none' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
            Queued {totalQueued > 0 && <span style={{ color: '#94a3b8', fontWeight: 500 }}>· {totalQueued}</span>}
          </div>
          {totalQueued > 0 && (
            <Btn onClick={() => sendAll()} disabled={sending}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Send size={15} /> {sending ? 'Sending…' : `Send all (${totalQueued})`}
              </span>
            </Btn>
          )}
        </div>
        {!queued && !error && <div style={{ padding: 16, color: '#64748b', fontSize: 13 }}>Loading…</div>}
        {queued && totalQueued === 0 && (
          <div style={{ padding: '32px 20px', textAlign: 'center', color: '#64748b', fontSize: 14 }}>
            Nothing queued. Queue offers and reminders from the tiles on the Pipeline tab.
          </div>
        )}
        {queued && queued.map((item) => <Row key={item.id} item={item} />)}
      </div>

      {recent.length > 0 && (
        <div style={card}>
          <div style={{ padding: '14px 16px', fontSize: 13, fontWeight: 700, color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>Recently sent</div>
          {recent.map((item) => <Row key={item.id} item={item} sent />)}
        </div>
      )}
    </div>
  );
}
