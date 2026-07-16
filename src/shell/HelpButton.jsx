import React, { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { HelpCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { resolveModuleId } from '../lib/help';

export default function HelpButton() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);

  const moduleId = resolveModuleId(pathname);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function handleOpen() {
    const next = !open;
    setOpen(next);
    if (next && moduleId) {
      setLoading(true);
      const { data, error } = await supabase
        .from('help_content')
        .select('title, body, screenshot_url')
        .eq('module_id', moduleId)
        .eq('section_key', 'overview')
        .maybeSingle();
      if (error) console.error('[HelpButton]', error);
      setContent(data || null);
      setLoading(false);
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={handleOpen}
        title="Help"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          padding: 6, borderRadius: 8, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <HelpCircle size={20} style={{ color: '#94a3b8' }} />
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
            {content?.title || 'Help'}
          </div>

          <div style={{ padding: '14px 16px' }}>
            {loading ? (
              <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</div>
            ) : !moduleId ? (
              <div style={{ fontSize: 12, color: '#94a3b8' }}>No help written for this page yet.</div>
            ) : (
              <>
                <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                  {content?.body || 'No help written for this page yet.'}
                </div>
                {content?.screenshot_url && (
                  <img
                    src={content.screenshot_url}
                    alt=""
                    style={{ marginTop: 10, width: '100%', borderRadius: 8, border: '1px solid #e5e7eb' }}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
