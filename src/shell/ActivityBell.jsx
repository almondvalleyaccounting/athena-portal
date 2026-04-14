import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { supabase } from '../lib/supabase';

const LS_KEY = 'athena_activity_last_seen';

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
    loadActivity();
    const interval = setInterval(loadActivity, 60000); // refresh every minute
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function loadActivity() {
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 86400000).toISOString();

      const [{ data: quotes }, { data: completed }] = await Promise.all([
        supabase.from('quotes')
          .select('id, quote_ref, status, relationship_group, updated_at')
          .gte('updated_at', twentyFourHoursAgo)
          .order('updated_at', { ascending: false })
          .limit(5),
        supabase.from('completed_tasks')
          .select('id, title, service, completed_at')
          .gte('completed_at', twentyFourHoursAgo)
          .order('completed_at', { ascending: false })
          .limit(5),
      ]);

      const all = [
        ...(quotes || []).map((q) => ({
          id: `q-${q.id}`,
          text: `${q.quote_ref} — ${q.status}`,
          sub: q.relationship_group,
          time: q.updated_at,
          path: `/manage/quotes/${q.id}`,
          type: 'quote',
        })),
        ...(completed || []).map((t) => ({
          id: `c-${t.id}`,
          text: `Completed: ${t.title}`,
          sub: t.service,
          time: t.completed_at,
          path: '/planner/completed',
          type: 'task',
        })),
      ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 10);

      setItems(all);

      // Unread count
      const lastSeen = localStorage.getItem(LS_KEY);
      if (lastSeen) {
        const count = all.filter((i) => new Date(i.time) > new Date(lastSeen)).length;
        setUnread(count);
      } else {
        setUnread(all.length);
      }
    } catch (e) {
      console.error('[ActivityBell]', e);
    }
  }

  function handleOpen() {
    setOpen(!open);
    if (!open) {
      localStorage.setItem(LS_KEY, new Date().toISOString());
      setUnread(0);
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
            background: '#38bdf8', color: '#fff',
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
          width: 320, maxHeight: 400, overflowY: 'auto',
          background: '#fff', border: '1px solid #e5e7eb',
          borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
          zIndex: 200, fontFamily: "'Outfit', sans-serif",
        }}>
          <div style={{
            padding: '12px 16px', fontSize: 13, fontWeight: 600, color: '#0f172a',
            borderBottom: '1px solid #f1f5f9',
          }}>
            Recent Activity
          </div>

          {items.length === 0 ? (
            <div style={{ padding: '20px 16px', fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>
              No recent activity
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                onClick={() => { navigate(item.path); setOpen(false); }}
                style={{
                  padding: '10px 16px', cursor: 'pointer',
                  borderBottom: '1px solid #f1f5f9',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ fontSize: 12, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
                  {item.text}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{item.sub}</span>
                  <span>{timeAgo(item.time)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
