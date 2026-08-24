import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Award, Plus, Send, ExternalLink, GraduationCap, MessageCircle } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import RadarChart from '../components/RadarChart';
import { Card, SectionTitle, Stat, Pill, ProgressBar, Button, FONT, SERIF, EmptyState, Select, Textarea, Input } from '../components/ui';
import {
  loadSkills, loadSkillLevels, loadObjectives, loadCpd, loadOneToOnes, loadActions,
  loadKudosFeed, createKudos, loadStaff, LEARNING_PARTNER,
  loadPrepContributionsAboutMe,
} from '../lib/api';

const BADGES = {
  star:   { emoji: '⭐', label: 'Star' },
  rocket: { emoji: '🚀', label: 'Rocket' },
  brain:  { emoji: '🧠', label: 'Brain' },
  heart:  { emoji: '💚', label: 'Heart' },
  trophy: { emoji: '🏆', label: 'Trophy' },
};

export default function DashboardView() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [skills, setSkills] = useState([]);
  const [levels, setLevels] = useState([]);
  const [objectives, setObjectives] = useState([]);
  const [cpd, setCpd] = useState([]);
  const [oneToOnes, setOneToOnes] = useState([]);
  const [actions, setActions] = useState([]);
  const [kudosFeed, setKudosFeed] = useState([]);
  const [staff, setStaff] = useState([]);
  // Feedback a colleague wrote about me and chose to show me (sql/260). Rows
  // they kept private to the person who asked never reach here.
  const [sharedFeedback, setSharedFeedback] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showKudosForm, setShowKudosForm] = useState(false);
  const [kudosDraft, setKudosDraft] = useState({ to_id: '', message: '', badge: 'star' });

  useEffect(() => {
    if (!profile?.id) return;
    (async () => {
      try {
        const [s, l, o, c, m, a, k, st, fb] = await Promise.all([
          loadSkills(), loadSkillLevels(profile.id), loadObjectives(profile.id),
          loadCpd(profile.id), loadOneToOnes(profile.id), loadActions(profile.id),
          loadKudosFeed(20), loadStaff(), loadPrepContributionsAboutMe(profile.id),
        ]);
        setSkills(s); setLevels(l); setObjectives(o); setCpd(c);
        setOneToOnes(m); setActions(a); setKudosFeed(k); setStaff(st);
        setSharedFeedback(fb);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [profile?.id]);

  // A colleague can share feedback with me at any moment; pick it up without a
  // reload. One indexed query, so a 60s beat costs nothing.
  const refreshSharedFeedback = useCallback(() => {
    if (!profile?.id) return;
    loadPrepContributionsAboutMe(profile.id).then(setSharedFeedback).catch((e) => console.error(e));
  }, [profile?.id]);

  useEffect(() => {
    if (!profile?.id) return undefined;
    const timer = setInterval(refreshSharedFeedback, 60000);
    const onFocus = () => { if (!document.hidden) refreshSharedFeedback(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refreshSharedFeedback, profile?.id]);

  const levelMap = useMemo(() => {
    const m = { current: {}, target: {}, onRadar: {} };
    levels.forEach((l) => {
      m.current[l.skill_id] = l.current_level;
      m.target[l.skill_id] = l.target_level;
      m.onRadar[l.skill_id] = !!l.show_on_radar;
    });
    return m;
  }, [levels]);

  const radarSkills = useMemo(
    () => skills.filter((s) => levelMap.onRadar[s.id]),
    [skills, levelMap],
  );

  const ytd = new Date().getFullYear();
  const ytdHours = cpd
    .filter((i) => new Date(i.entry_date).getFullYear() === ytd)
    .reduce((acc, i) => acc + Number(i.hours || 0), 0);

  const openObjectives = objectives.filter((o) => o.status !== 'complete' && o.status !== 'abandoned');
  const completedObjectives = objectives.filter((o) => o.status === 'complete');
  const openActions = actions.filter((a) => a.status === 'open');
  const overallProgress = openObjectives.length === 0
    ? 0
    : Math.round(openObjectives.reduce((a, o) => a + o.progress_pct, 0) / openObjectives.length);

  const totalGap = useMemo(() => {
    return skills.reduce((acc, s) => {
      const cur = levelMap.current[s.id] ?? 0;
      const tgt = levelMap.target[s.id] ?? 0;
      return acc + Math.max(0, tgt - cur);
    }, 0);
  }, [skills, levelMap]);

  const topGap = useMemo(() => {
    let best = null;
    skills.forEach((s) => {
      const gap = (levelMap.target[s.id] ?? 0) - (levelMap.current[s.id] ?? 0);
      if (gap > 0 && (!best || gap > best.gap)) best = { skill: s, gap };
    });
    return best;
  }, [skills, levelMap]);

  const lastOneToOne = oneToOnes[0];

  const submitKudos = async () => {
    if (!kudosDraft.to_id || !kudosDraft.message.trim()) return;
    try {
      const saved = await createKudos({
        from_id: profile.id,
        to_id: kudosDraft.to_id,
        message: kudosDraft.message.trim(),
        badge: kudosDraft.badge,
      });
      setKudosFeed((p) => [saved, ...p]);
      setKudosDraft({ to_id: '', message: '', badge: 'star' });
      setShowKudosForm(false);
    } catch (e) { console.error(e); }
  };

  const staffName = (id) => staff.find((s) => s.id === id)?.name || 'Someone';

  if (loading) {
    return <p style={{ fontFamily: FONT, color: '#94a3b8', textAlign: 'center', padding: 60 }}>Loading your CPD profile…</p>;
  }

  const greeting = getGreeting();

  return (
    <div style={{ padding: '32px 32px 80px', maxWidth: 1280, margin: '0 auto' }}>
      {/* Hero */}
      <div style={{
        background: 'linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)',
        color: '#fff',
        borderRadius: 18,
        padding: '28px 32px',
        marginBottom: 24,
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', top: -40, right: -40, width: 200, height: 200, background: 'rgba(56,189,248,0.18)', borderRadius: '50%', filter: 'blur(60px)' }} />
        <div style={{ fontFamily: FONT, fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.7 }}>{greeting},</div>
        <div style={{ fontFamily: SERIF, fontSize: 32, fontWeight: 500, marginTop: 4 }}>{profile.name?.split(' ')[0] || 'there'} 👋</div>
        <div style={{ fontFamily: FONT, fontSize: 14, opacity: 0.85, marginTop: 8, maxWidth: 600 }}>
          {topGap
            ? <>Your biggest growth opportunity right now is <strong>{topGap.skill.name}</strong> — a gap of {topGap.gap} levels. Small, deliberate steps add up fast.</>
            : 'Set a few targets in the Skills tab and we\'ll surface where to focus.'}
        </div>
      </div>

      {/* Feedback colleagues chose to show me. Only ever what its author
          addressed to me — see sql/260. */}
      {sharedFeedback.length > 0 && (
        <Card style={{ marginBottom: 24, borderColor: '#c7d2fe' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <MessageCircle size={17} color="#4338ca" />
            <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a' }}>
              Feedback shared with you ({sharedFeedback.length})
            </div>
          </div>
          <p style={{ fontFamily: FONT, fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
            Written by a colleague, and shown to you because they chose to. Bring it to your next 1-2-1
            if you want to talk it through.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {sharedFeedback.map((f) => (
              <div key={f.id} style={{ border: '1px solid #eef2ff', background: '#fbfcfe', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontFamily: FONT, fontSize: 12, fontWeight: 700, color: '#0f172a' }}>
                    {f.contributor?.name || 'A colleague'}
                  </span>
                  <Pill bg={f.kind === 'work' ? '#eff6ff' : '#f5f3ff'} fg={f.kind === 'work' ? '#0e7fe0' : '#7c3aed'}>
                    {f.kind === 'work' ? 'Work' : 'Development'}
                  </Pill>
                  <span style={{ fontFamily: FONT, fontSize: 11, color: '#cbd5e1' }}>
                    {new Date(f.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </span>
                </div>
                <div style={{ fontFamily: FONT, fontSize: 13, color: '#1e293b', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{f.body}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Stat row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
        <Stat label="CPD YTD" value={`${ytdHours.toFixed(1)}h`} sub="hours logged" accent="#0e7fe0" />
        <Stat label="Active objectives" value={openObjectives.length} sub={`${overallProgress}% avg progress`} />
        <Stat label="Skill gap total" value={totalGap} sub="levels to close" accent={totalGap > 0 ? '#dc2626' : '#16a34a'} />
        <Stat label="Open actions" value={openActions.length} sub={`from ${oneToOnes.length} 1-2-1s`} accent={openActions.length > 0 ? '#92400e' : '#16a34a'} />
      </div>

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 24 }}>
        {/* Skills radar */}
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a' }}>Your skill profile</div>
            <button onClick={() => navigate('/team/pd/skills')} style={linkBtn}>Open skill matrix →</button>
          </div>
          {radarSkills.length >= 3 ? (
            <RadarChart skills={radarSkills} current={levelMap.current} target={levelMap.target} size={420} />
          ) : (
            <EmptyState title="Pick at least 3 skills to track" hint="In Skills, tap the star next to any skill to add it here." />
          )}
        </Card>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Objectives summary */}
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a' }}>Objectives</div>
              <button onClick={() => navigate('/team/pd/objectives')} style={linkBtn}>View all →</button>
            </div>
            {openObjectives.length === 0 ? (
              <EmptyState title="No active objectives" hint="Set some to focus your development." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {openObjectives.slice(0, 3).map((o) => (
                  <div key={o.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                      <div style={{ fontFamily: FONT, fontSize: 13, fontWeight: 500, color: '#0f172a' }}>{o.title}</div>
                      <div style={{ fontFamily: FONT, fontSize: 12, color: '#64748b' }}>{o.progress_pct}%</div>
                    </div>
                    <ProgressBar value={o.progress_pct} />
                  </div>
                ))}
                {completedObjectives.length > 0 && (
                  <div style={{ marginTop: 6, fontFamily: FONT, fontSize: 12, color: '#16a34a' }}>
                    🏆 {completedObjectives.length} completed objective{completedObjectives.length === 1 ? '' : 's'} — well done!
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Last 1-2-1 */}
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a' }}>Last 1-2-1</div>
              <button onClick={() => navigate('/team/pd/one-to-ones')} style={linkBtn}>All meetings →</button>
            </div>
            {lastOneToOne ? (
              <div>
                <div style={{ fontFamily: FONT, fontSize: 13, color: '#475569' }}>
                  {new Date(lastOneToOne.meeting_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                  {lastOneToOne.duration_mins && ` · ${lastOneToOne.duration_mins} mins`}
                </div>
                {lastOneToOne.what_went_well && (
                  <div style={{ marginTop: 10, padding: 10, background: '#dcfce7', borderRadius: 8, fontFamily: FONT, fontSize: 13, color: '#1e293b' }}>
                    <strong style={{ color: '#166534' }}>Went well:</strong> {truncate(lastOneToOne.what_went_well, 140)}
                  </div>
                )}
                {openActions.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <Pill bg="#fef3c7" fg="#92400e">{openActions.length} open action{openActions.length === 1 ? '' : 's'}</Pill>
                  </div>
                )}
              </div>
            ) : (
              <EmptyState title="No 1-2-1s logged yet" hint="Capture your next one." />
            )}
          </Card>
        </div>
      </div>

      {/* Learning partner banner */}
      <a
        href={LEARNING_PARTNER.url}
        target="_blank"
        rel="noreferrer"
        style={{
          display: 'flex', alignItems: 'center', gap: 18,
          background: 'linear-gradient(120deg, #fef3c7 0%, #fde68a 100%)',
          border: '1px solid #fde68a',
          borderRadius: 14,
          padding: '16px 22px',
          marginTop: 24,
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        <div style={{
          width: 50, height: 50, borderRadius: 14, background: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          boxShadow: '0 2px 6px rgba(146, 64, 14, 0.15)',
        }}>
          <GraduationCap size={26} color="#92400e" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 500, color: '#78350f' }}>
            Visit {LEARNING_PARTNER.name}
          </div>
          <div style={{ fontFamily: FONT, fontSize: 13, color: '#92400e', marginTop: 2 }}>
            {LEARNING_PARTNER.blurb}
          </div>
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: FONT, fontSize: 13, fontWeight: 600, color: '#78350f',
          flexShrink: 0,
        }}>
          Open <ExternalLink size={13} />
        </div>
      </a>

      {/* Bottom row: kudos + recent CPD */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 24, marginTop: 24 }}>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Award size={18} color="#dc2626" />
              <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a' }}>Kudos wall</div>
            </div>
            <Button variant="ghost" onClick={() => setShowKudosForm((v) => !v)}>
              <Plus size={12} style={{ marginRight: 4, verticalAlign: 'text-bottom' }} />
              Send kudos
            </Button>
          </div>

          {showKudosForm && (
            <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
                <Select value={kudosDraft.to_id} onChange={(e) => setKudosDraft({ ...kudosDraft, to_id: e.target.value })}>
                  <option value="">Who deserves it?</option>
                  {staff.filter((s) => s.id !== profile.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
                <Select value={kudosDraft.badge} onChange={(e) => setKudosDraft({ ...kudosDraft, badge: e.target.value })}>
                  {Object.entries(BADGES).map(([k, v]) => <option key={k} value={k}>{v.emoji} {v.label}</option>)}
                </Select>
              </div>
              <Textarea
                placeholder="What did they do that deserves a shout-out?"
                value={kudosDraft.message}
                onChange={(e) => setKudosDraft({ ...kudosDraft, message: e.target.value })}
                style={{ minHeight: 60 }}
              />
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button variant="ghost" onClick={() => setShowKudosForm(false)}>Cancel</Button>
                <Button variant="accent" onClick={submitKudos} disabled={!kudosDraft.to_id || !kudosDraft.message.trim()}>
                  <Send size={12} style={{ marginRight: 4, verticalAlign: 'text-bottom' }} />
                  Send
                </Button>
              </div>
            </div>
          )}

          {kudosFeed.length === 0 ? (
            <EmptyState title="No kudos yet" hint="Be the first to celebrate someone." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {kudosFeed.map((k) => {
                const b = BADGES[k.badge] || BADGES.star;
                return (
                  <div key={k.id} style={{ display: 'flex', gap: 12, padding: 10, background: '#fafaf9', borderRadius: 10 }}>
                    <div style={{
                      width: 38, height: 38, borderRadius: 12, background: '#fff7ed',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0,
                    }}>{b.emoji}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: FONT, fontSize: 12, color: '#64748b' }}>
                        <strong style={{ color: '#0f172a' }}>{staffName(k.from_id)}</strong>
                        {' → '}
                        <strong style={{ color: '#0e7fe0' }}>{staffName(k.to_id)}</strong>
                        <span style={{ marginLeft: 8 }}>{relativeTime(k.created_at)}</span>
                      </div>
                      <div style={{ fontFamily: FONT, fontSize: 13, color: '#1e293b', marginTop: 4 }}>
                        {k.message}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Sparkles size={18} color="#0e7fe0" />
              <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a' }}>Recent CPD</div>
            </div>
            <button onClick={() => navigate('/team/pd/cpd')} style={linkBtn}>Full log →</button>
          </div>
          {cpd.length === 0 ? (
            <EmptyState title="No CPD logged yet" hint="Even 15 mins of reading counts." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {cpd.slice(0, 5).map((c) => (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderTop: '1px solid #f1f5f9' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: FONT, fontSize: 13, fontWeight: 500, color: '#0f172a' }}>{c.title}</div>
                    <div style={{ fontFamily: FONT, fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                      {new Date(c.entry_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      {c.provider && ` · ${c.provider}`}
                    </div>
                  </div>
                  <span style={{ fontFamily: FONT, fontSize: 12, fontWeight: 700, color: '#0e7fe0', flexShrink: 0 }}>{Number(c.hours).toFixed(1)}h</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

const linkBtn = {
  background: 'none', border: 'none', cursor: 'pointer', color: '#0e7fe0',
  fontFamily: FONT, fontSize: 12, fontWeight: 600,
};

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function relativeTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
