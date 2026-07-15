import React, { useEffect, useState } from 'react';
import { theme as t } from './theme';

/*
  First-sign-in "WOW" moment: a full-screen animated welcome that plays once
  (localStorage flag), then gracefully hands over to the portal. Pure CSS
  animations — respects prefers-reduced-motion via the global rules.
*/
export default function IntroOverlay({ onDone }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const leave = setTimeout(() => setLeaving(true), 2600);
    const done = setTimeout(() => onDone(), 3400);
    return () => { clearTimeout(leave); clearTimeout(done); };
  }, [onDone]);

  return (
    <div
      onClick={() => { setLeaving(true); setTimeout(onDone, 500); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `linear-gradient(120deg, ${t.navyDark}, ${t.navy} 40%, ${t.teal})`,
        backgroundSize: '220% 220%',
        animation: 'gradientPan 6s ease infinite',
        opacity: leaving ? 0 : 1,
        transition: 'opacity 0.8s ease',
        cursor: 'pointer',
      }}
    >
      <div className="blob" style={{ width: 340, height: 340, background: '#F5C518', top: '-80px', right: '-60px', opacity: 0.25 }} />
      <div className="blob" style={{ width: 420, height: 420, background: t.teal, bottom: '-140px', left: '-100px', opacity: 0.35, animationDelay: '2s' }} />

      <div style={{ textAlign: 'center', color: '#fff', padding: 24 }}>
        <div className="pop-in" style={{ fontSize: 54, marginBottom: 18, animationDelay: '0.15s' }}>👋</div>
        <div className="fade-up" style={{ fontSize: 'clamp(26px, 6vw, 42px)', fontWeight: 700, letterSpacing: 0.5, animationDelay: '0.4s' }}>
          Welcome to Almond Valley Accounting
        </div>
        <div className="fade-up" style={{ fontSize: 'clamp(15px, 3vw, 18px)', color: 'rgba(255,255,255,0.85)', marginTop: 12, animationDelay: '0.9s' }}>
          Accounting that keeps you in the loop — let's get you set up.
        </div>
        <div className="fade-up" style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 40, animationDelay: '1.6s' }}>
          tap anywhere to continue
        </div>
      </div>
    </div>
  );
}
