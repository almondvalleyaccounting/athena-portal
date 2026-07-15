import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { theme as t } from './theme';
import IntroOverlay from './IntroOverlay';
import StepCard from './StepCard';
import QuoteCard from './QuoteCard';
import GroupsSection from './GroupsSection';
import ServicesSection from './ServicesSection';

/*
  Onboarding portal home. All data comes from SECURITY DEFINER RPCs that
  expose only client-safe fields:
    portal_claim_invites()     — links this login to invited client entities
    portal_my_onboarding()     — entities + progress + quote + services + steps
    portal_step_reply()        — message the team about a step
    portal_step_action()       — I've done this / sent another way / not arrived
    portal_register_document() — registers an upload (client-documents bucket)
    portal_service_catalogue() — indicative from-prices for add-on services
    portal_request_service()   — request an additional service

  The page silently refreshes every 60s and on tab focus, so staff progress
  in Athena (VAT registered, PAYE set up…) shows up while the client watches.
*/

function ProgressRing({ done, total, size = 108 }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const [offset, setOffset] = useState(c);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOffset(c - (pct / 100) * c));
    return () => cancelAnimationFrame(id);
  }, [pct, c]);
  return (
    <svg className="progress-ring" width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="8" />
      <circle
        className="fg" cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={pct === 100 ? '#4ade80' : '#F5C518'} strokeWidth="8" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fill="#fff" fontSize={size / 4.5} fontWeight="700" fontFamily="'Outfit', sans-serif">
        {pct}%
      </text>
    </svg>
  );
}

function SectionTitle({ children, sub, delay = 0 }) {
  return (
    <>
      <div className="fade-up" style={{ fontSize: 14, fontWeight: 700, color: t.text, margin: '22px 0 4px', animationDelay: `${delay}ms` }}>
        {children}
      </div>
      {sub && <div className="fade-up" style={{ fontSize: 12.5, color: t.muted, marginBottom: 10, animationDelay: `${delay + 20}ms` }}>{sub}</div>}
      {!sub && <div style={{ marginBottom: 10 }} />}
    </>
  );
}

export default function PortalHome({ session }) {
  const [data, setData] = useState(null);
  const [catalogue, setCatalogue] = useState([]);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState(null);
  const [showDone, setShowDone] = useState({});
  const claimed = useRef(false);
  const [showIntro, setShowIntro] = useState(() => {
    try { return !localStorage.getItem('ava_seen_intro'); } catch { return false; }
  });

  const load = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!claimed.current) {
        const { error: claimErr } = await supabase.rpc('portal_claim_invites');
        if (claimErr) throw claimErr;
        claimed.current = true;
      }
      const [ob, cat, reqs] = await Promise.all([
        supabase.rpc('portal_my_onboarding'),
        supabase.rpc('portal_service_catalogue'),
        supabase.from('portal_service_requests').select('service_id, entity_id, status, created_at'),
      ]);
      if (ob.error) throw ob.error;
      setData(ob.data || []);
      if (!cat.error) setCatalogue(cat.data || []);
      if (!reqs.error) setRequests(reqs.data || []);
      setError(null);
    } catch (e) {
      if (!silent) setError(e.message);
    }
  }, []);

  // Initial load + keep it feeling live: refresh on tab focus and every 60s.
  useEffect(() => {
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load({ silent: true }); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const id = setInterval(() => load({ silent: true }), 60000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      clearInterval(id);
    };
  }, [load]);

  function dismissIntro() {
    try { localStorage.setItem('ava_seen_intro', '1'); } catch { /* private mode */ }
    setShowIntro(false);
  }

  async function reply(stepId, message) {
    try {
      const { error: err } = await supabase.rpc('portal_step_reply', { p_step_id: stepId, p_message: message });
      if (err) throw err;
      load({ silent: true });
      return true;
    } catch (e) { setError(e.message); return false; }
  }

  async function stepAction(stepId, action, note) {
    try {
      const { error: err } = await supabase.rpc('portal_step_action', { p_step_id: stepId, p_action: action, p_note: note });
      if (err) throw err;
      load({ silent: true });
      return true;
    } catch (e) { setError(e.message); return false; }
  }

  async function requestService(entityId, serviceId, title, note) {
    try {
      const { error: err } = await supabase.rpc('portal_request_service', {
        p_entity_id: entityId, p_service_id: serviceId, p_service_title: title, p_note: note,
      });
      if (err) throw err;
      load({ silent: true });
      return true;
    } catch (e) { setError(e.message); return false; }
  }

  async function upload(stepId, entityId, file) {
    try {
      const safeName = file.name.replace(/[^\w.\- ]+/g, '_');
      const path = `${entityId}/${crypto.randomUUID()}-${safeName}`;
      const { error: upErr } = await supabase.storage
        .from('client-documents')
        .upload(path, file, { contentType: file.type || undefined });
      if (upErr) throw upErr;
      const { error: rpcErr } = await supabase.rpc('portal_register_document', {
        p_step_id: stepId, p_path: path, p_name: file.name,
        p_mime: file.type || null, p_size: file.size,
      });
      if (rpcErr) throw rpcErr;
      await load({ silent: true }); // step flips to "With us — we're checking it"
      return true;
    } catch (e) {
      setError(e.message?.includes('mime') || e.message?.includes('size')
        ? 'That file type or size isn’t supported — photos, PDFs and Office documents up to 20MB work best.'
        : e.message);
      return false;
    }
  }

  const onboardings = (data || []).flatMap((ent) =>
    (ent.onboardings || []).map((ob) => ({ ...ob, entityName: ent.entity_name, entityId: ent.entity_id })));

  return (
    <div style={{ minHeight: '100vh' }}>
      {showIntro && <IntroOverlay onDone={dismissIntro} />}

      <header style={{ background: t.navy, padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
          <img src="/ava-logo.jpg" alt="" style={{ width: 34, height: 34, borderRadius: 9, objectFit: 'cover', flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 15.5, letterSpacing: 0.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Almond Valley Accounting
            </div>
            <div style={{ color: '#9db6c8', fontSize: 11.5 }}>Client portal</div>
          </div>
        </div>
        <button
          onClick={() => supabase.auth.signOut()}
          style={{ background: 'rgba(255,255,255,0.12)', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}
        >
          Sign out
        </button>
      </header>

      <main style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px 60px' }}>
        {error && (
          <div style={{ fontSize: 13.5, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '10px 14px', marginBottom: 14 }}>
            {error} <button onClick={() => { setError(null); load(); }} style={{ border: 'none', background: 'none', color: '#b91c1c', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
          </div>
        )}
        {!data && !error && <div style={{ color: t.faint, fontSize: 14 }}>Loading…</div>}

        {data && onboardings.length === 0 && (
          <div className="fade-up" style={{ background: '#fff', border: `1px solid ${t.border}`, borderRadius: 16, padding: '36px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: t.navy, marginBottom: 6 }}>Nothing here just yet</div>
            <p style={{ fontSize: 13.5, color: t.muted, lineHeight: 1.6, margin: 0 }}>
              You're signed in as <strong>{session.user.email}</strong>, but there's nothing linked to
              this email yet. If you're expecting to see your setup progress, get in touch and we'll
              connect your account.
            </p>
          </div>
        )}

        {onboardings.map((ob) => {
          const steps = ob.client_steps || [];
          const isClientStep = (s) => !s.owner_type || s.owner_type === 'client';
          const needsYou = steps.filter((s) => isClientStep(s) && ['waiting_client', 'blocked'].includes(s.status));
          const withUs = steps.filter((s) => s.status === 'received');
          const inHand = steps.filter((s) => s.status === 'waiting_external' || (!isClientStep(s) && ['waiting_client', 'blocked'].includes(s.status)));
          const upcoming = steps.filter((s) => s.status === 'pending');
          const done = steps.filter((s) => s.status === 'complete');
          const isComplete = ob.status === 'complete' || (ob.progress?.total > 0 && ob.progress.done === ob.progress.total);
          const doneOpen = showDone[ob.id];

          const heroLine = isComplete
            ? "All done — you're fully set up. Thank you for choosing us."
            : needsYou.length > 0
              ? `${ob.progress?.done || 0} of ${ob.progress?.total || 0} steps done. ${needsYou.length} thing${needsYou.length === 1 ? '' : 's'} need${needsYou.length === 1 ? 's' : ''} your attention below — we're taking care of the rest.`
              : upcoming.length > 0
                ? `${ob.progress?.done || 0} of ${ob.progress?.total || 0} steps done. Nothing is needed from you just now — here's what's coming up.`
                : `${ob.progress?.done || 0} of ${ob.progress?.total || 0} steps done. Nothing is needed from you right now — we're taking care of the rest.`;

          return (
            <div key={ob.id} style={{ marginBottom: 30 }}>
              {/* Hero */}
              <div className="fade-up" style={{
                position: 'relative', overflow: 'hidden', borderRadius: 20,
                background: `linear-gradient(120deg, ${t.navyDark}, ${t.navy} 55%, ${t.teal})`,
                backgroundSize: '200% 200%', animation: 'gradientPan 10s ease infinite',
                padding: '26px 22px', color: '#fff', marginBottom: 16,
              }}>
                <div className="blob" style={{ width: 220, height: 220, background: '#F5C518', top: -70, right: -50, opacity: 0.18 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                  <ProgressRing done={ob.progress?.done || 0} total={ob.progress?.total || 0} />
                  <div style={{ flex: '1 1 220px' }}>
                    <div style={{ fontSize: 12.5, letterSpacing: 1.2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.65)', fontWeight: 600 }}>
                      Getting you set up
                    </div>
                    <div style={{ fontSize: 'clamp(20px, 4.5vw, 26px)', fontWeight: 700, margin: '6px 0 8px', overflowWrap: 'anywhere' }}>
                      {ob.entityName}
                    </div>
                    <div style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.85)', lineHeight: 1.55 }}>{heroLine}</div>
                  </div>
                </div>
              </div>

              {/* Needs you */}
              {needsYou.length > 0 && (
                <>
                  <SectionTitle delay={80}>What we need from you</SectionTitle>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {needsYou.map((s, i) => (
                      <StepCard key={s.id} step={s} entityId={ob.entityId} onReply={reply} onUpload={upload} onAction={stepAction} delay={120 + i * 70} />
                    ))}
                  </div>
                </>
              )}
              {needsYou.length === 0 && !isComplete && upcoming.length === 0 && withUs.length === 0 && (
                <div className="fade-up" style={{ marginTop: 4, fontSize: 13.5, color: t.successText, background: t.successSoft, borderRadius: 12, padding: '12px 16px', animationDelay: '120ms' }}>
                  There's nothing you need to do right now — we'll email you if that changes.
                </div>
              )}

              {/* Being checked */}
              {withUs.length > 0 && (
                <>
                  <SectionTitle delay={160} sub="You've sent these — we're reviewing them and will mark them complete.">
                    With us
                  </SectionTitle>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {withUs.map((s, i) => (
                      <StepCard key={s.id} step={s} entityId={ob.entityId} onReply={reply} onUpload={upload} onAction={stepAction} delay={180 + i * 60} />
                    ))}
                  </div>
                </>
              )}

              {/* In hand — waiting on third parties, nothing needed */}
              {inHand.length > 0 && (
                <>
                  <SectionTitle delay={200} sub="In progress with HMRC and other third parties — no action needed from you.">
                    In hand
                  </SectionTitle>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {inHand.map((s, i) => (
                      <StepCard key={s.id} step={s} entityId={ob.entityId} onReply={reply} onUpload={upload} onAction={stepAction} delay={220 + i * 60} />
                    ))}
                  </div>
                </>
              )}

              {/* Coming up */}
              {upcoming.length > 0 && (
                <>
                  <SectionTitle delay={220} sub="We'll let you know when these are needed — feel free to get ahead of them.">
                    Coming up
                  </SectionTitle>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {upcoming.map((s, i) => (
                      <StepCard key={s.id} step={s} entityId={ob.entityId} onReply={reply} onUpload={upload} onAction={stepAction} delay={240 + i * 50} />
                    ))}
                  </div>
                </>
              )}

              {/* Done (collapsed) */}
              {done.length > 0 && (
                <div className="fade-up" style={{ marginTop: 16, animationDelay: '280ms' }}>
                  <button
                    onClick={() => setShowDone((x) => ({ ...x, [ob.id]: !x[ob.id] }))}
                    style={{ background: 'none', border: 'none', color: t.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 }}
                  >
                    {doneOpen ? '▾' : '▸'} Done ({done.length})
                  </button>
                  {doneOpen && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {done.map((s) => (
                        <div key={s.id} style={{ fontSize: 13, color: t.muted, display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ color: t.success, fontWeight: 700 }}>✓</span>
                          <span style={{ textDecoration: 'line-through', opacity: 0.75 }}>{s.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Behind the scenes */}
              <GroupsSection groups={ob.groups} delay={320} />

              {/* Quote */}
              {ob.quote && (
                <div style={{ marginTop: 24 }}>
                  <QuoteCard quote={ob.quote} delay={360} />
                </div>
              )}

              {/* Services + add-ons */}
              <ServicesSection
                services={ob.services || []}
                catalogue={catalogue}
                requests={requests.filter((r) => r.entity_id === ob.entityId)}
                onRequest={(sid, title, note) => requestService(ob.entityId, sid, title, note)}
                delay={400}
              />
            </div>
          );
        })}

        <div style={{ textAlign: 'center', fontSize: 12, color: t.faint, marginTop: 10, lineHeight: 1.6 }}>
          Questions? Use “Message us” on any step above, or reply to any of our emails —
          they come straight to the team.
        </div>
      </main>
    </div>
  );
}
