import React, { useEffect, useState } from 'react';

// "A newer version of Athena is available — Reload."
//
// Athena deploys on every push to master, but a tab opened before a deploy
// keeps running the old code until it's reloaded. On 2026-09-25 that let a
// fee change be approved through an Approve button the new version had
// already replaced. This checks, on focus and every five minutes, whether
// the page Vercel is now serving loads a different main script from the one
// this tab is running, and if so asks for a reload. No build step needed:
// Vite fingerprints the script name, so a new build means a new name.

const CHECK_EVERY_MS = 5 * 60 * 1000;

function runningScript() {
  const el = [...document.querySelectorAll('script[type="module"][src]')].find((s) => /\/assets\/index-[^/]+\.js$/.test(s.getAttribute('src') || ''));
  return el ? el.getAttribute('src') : null;
}

export default function UpdateBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const mine = runningScript();
    if (!mine) return undefined; // dev server: nothing to compare
    let stopped = false;
    const check = async () => {
      try {
        const html = await (await fetch(`/?v=${Date.now()}`, { cache: 'no-store' })).text();
        const served = (html.match(/\/assets\/index-[^"']+\.js/) || [])[0];
        if (!stopped && served && served !== mine) setStale(true);
      } catch { /* offline — try again later */ }
    };
    const id = setInterval(check, CHECK_EVERY_MS);
    window.addEventListener('focus', check);
    check();
    return () => { stopped = true; clearInterval(id); window.removeEventListener('focus', check); };
  }, []);

  if (!stale) return null;
  return (
    <div role="status" style={{ background: '#193a50', color: '#fff', fontSize: 13, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center' }}>
      <span>A newer version of Athena is available.</span>
      <button onClick={() => window.location.reload()} style={{ background: '#fff', color: '#193a50', border: 'none', borderRadius: 6, padding: '4px 12px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
        Reload
      </button>
    </div>
  );
}
