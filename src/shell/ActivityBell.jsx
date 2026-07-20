import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { supabase } from '../lib/supabase';

// The bell is YOUR notifications (the notifications table — assignments,
// replies, stuck-state nudges from the nightly sweep), not a generic activity
// feed. Read state is server-side (read_at), so it follows you across
// devices; opening the panel marks everything read.

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ActivityBell() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const ref = useRef(null);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000); // refresh every minute
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function load() {
    try {
      // RLS scopes this to the signed-in user's rows.
      const { data } = await supabase
        .from('notifications')
        .select('id, kind, title, link_path, created_at, read_at')
        .order('created_at', { ascending: false })
        .limit(15);
      setItems(data || []);
      setUnread((data || []).filter((n) => !n.read_at).length);
    } catch (e) {
      console.error('[ActivityBell]', e);
    }
  }

  async function handleOpen() {
    const opening = !open;
    setOpen(opening);
    if (opening && unread > 0) {
      setUnread(0);
      const now = new Date().toISOString();
      setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at || now })));
      try {
        await supabase.rpc('mark_notifications_read');
      } catch (e) { console.error('[ActivityBell] mark read', e); }
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={handleOpen}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          padding: 6, borderRadius: 8, position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Bell size={20} style={{ color: '#94a3b8' }} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2,
            width: 16, height: 16, borderRadius: '50%',
            background: '#0e7fe0', color: '#fff',
            fontSize: 9, fontWeight: 700, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontFamily: "'Outfit', sans-serif",
          }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 8,
          width: 340, maxHeight: 420, overflowY: 'auto',
          background: '#fff', border: '1px solid #e5e7eb',
          borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
          zIndex: 200, fontFamily: "'Outfit', sans-serif",
        }}>
          <div style={{
            padding: '12px 16px', fontSize: 13, fontWeight: 600, color: '#0f172a',
            borderBottom: '1px solid #f1f5f9',
          }}>
            Notifications
          </div>

          {items.length === 0 ? (
            <div style={{ padding: '20px 16px', fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>
              Nothing for you right now
            </div>
          ) : (
            items.map((n) => (
              <div
                key={n.id}
                onClick={() => { if (n.link_path) navigate(n.link_path); setOpen(false); }}
                style={{
                  padding: '10px 16px', cursor: n.link_path ? 'pointer' : 'default',
                  borderBottom: '1px solid #f1f5f9',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  {!n.read_at && (
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#0e7fe0', flexShrink: 0, marginTop: 5 }} />
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: n.read_at ? 400 : 600, color: '#0f172a', marginBottom: 2 }}>
                      {n.title}
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>{timeAgo(n.created_at)}</div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
