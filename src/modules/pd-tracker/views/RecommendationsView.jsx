import React, { useEffect, useMemo, useState } from 'react';
import { Sparkles, ArrowRight, BookOpen, Target as TargetIcon } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { Card, SectionTitle, Pill, Button, EmptyState, FONT, SERIF } from '../components/ui';
import { loadSkills, loadSkillLevels, createObjective } from '../lib/api';

const SUGGESTIONS = {
  // skill name (lowercased) → list of recommended actions
  default: [
    'Block 1 hour a week to deliberately practise',
    'Find someone in the team a level above and shadow them',
    'Pick a recent piece of work and walk through it with your manager',
  ],
  'xero': [
    'Complete the free Xero Advisor Certification',
    'Set up a sandbox client and run through bank rules + repeating invoices',
    'Watch the official Xero Advisor webinars on conversions',
  ],
  'quickbooks online': [
    'Run the free QBO ProAdvisor course',
    'Practise importing and categorising 12 months of bank data in a sandbox',
  ],
  'excel / google sheets': [
    'Pick three real workpapers and rebuild them with INDEX/MATCH (or XLOOKUP) and pivot tables',
    'Try Microsoft Learn’s "Excel for accountants" path',
  ],
  'corporation tax (ct600)': [
    'Take an ICAS / CIOT short course on capital allowances',
    'Walk through one CT600 with your manager and explain every box',
  ],
  'personal tax (sa100)': [
    'Run a "self-assessment marathon" — prep 5 returns of varying complexity in a focused block',
    'Read the HMRC SA manual for the most common income types you handle',
  ],
  'vat returns & schemes': [
    'Complete the AAT VAT for accounting professionals course',
    'Review HMRC partial exemption guidance and try a worked example',
  ],
  'payroll & paye': [
    'Run the CIPP intro to PAYE course',
    'Process a full month-end payroll in a sandbox with starters and leavers',
  ],
  'management accounts': [
    'Build one client a full MI pack including KPIs and commentary',
    'Read "Financial Intelligence" (Berman & Knight)',
  ],
  'cash flow & forecasting': [
    'Build a 13-week cash forecast for one client end-to-end',
    'Try Float / Fathom / Spotlight free trials and compare',
  ],
  'client communication': [
    'Volunteer to run the next client onboarding meeting',
    'Practise structured update emails — subject, decision needed, options, recommendation',
  ],
  'time & priority management': [
    'Try the timeboxing approach for two weeks',
    'Review your week each Friday — what got cut, why?',
  ],
  'mentoring & feedback': [
    'Pair up with someone more junior weekly for 30 mins',
    'Read "Radical Candor" (Kim Scott)',
  ],
  'problem solving': [
    'Document tricky issues with the Cynefin framework lens',
    'Practise stating problems before solutions in 1-2-1s',
  ],
  'commercial awareness': [
    'Pick three clients and write a one-page summary of how they make money',
    'Read the FT each morning for two weeks',
  ],
  'companies house filing': [
    'Walk through every option on a CS01 and AA01 with your manager',
  ],
  'athena portal mastery': [
    'Pick a module a week — try every button and read the related notes',
  ],
};

function suggestionsFor(skillName) {
  const key = skillName.toLowerCase();
  return SUGGESTIONS[key] || SUGGESTIONS.default;
}

export default function RecommendationsView() {
  const { profile } = useAuth();
  const [skills, setSkills] = useState([]);
  const [levels, setLevels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    if (!profile?.id) return;
    (async () => {
      try {
        const [s, l] = await Promise.all([loadSkills(), loadSkillLevels(profile.id)]);
        setSkills(s); setLevels(l);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [profile?.id]);

  const gaps = useMemo(() => {
    const map = {};
    levels.forEach((l) => { map[l.skill_id] = l; });
    return skills
      .map((s) => {
        const l = map[s.id];
        const cur = l?.current_level ?? 0;
        const tgt = l?.target_level ?? 0;
        return { skill: s, current: cur, target: tgt, gap: tgt - cur };
      })
      .filter((x) => x.gap > 0)
      .sort((a, b) => b.gap - a.gap);
  }, [skills, levels]);

  const noTargets = levels.every((l) => (l.target_level ?? 0) === 0);

  const turnIntoObjective = async (g) => {
    setBusyId(g.skill.id);
    try {
      await createObjective({
        staff_id: profile.id,
        title: `Develop: ${g.skill.name} (${g.current} → ${g.target})`,
        description: `Move from level ${g.current} to ${g.target} on ${g.skill.name}.`,
        priority: g.gap >= 3 ? 'high' : g.gap === 2 ? 'medium' : 'low',
        linked_skill_id: g.skill.id,
        progress_pct: 0, status: 'open',
      });
      alert('Added to your objectives ✨');
    } catch (e) { console.error(e); alert('Could not save objective.'); }
    setBusyId(null);
  };

  return (
    <div style={{ padding: '32px 32px 80px', maxWidth: 980, margin: '0 auto' }}>
      <SectionTitle
        kicker="Recommendations"
        title="Where the lever is biggest"
        hint="Skills with the largest gap between today and where you want to be."
      />

      {loading ? (
        <p style={{ fontFamily: FONT, color: '#94a3b8', textAlign: 'center', padding: 40 }}>Crunching the numbers…</p>
      ) : noTargets ? (
        <EmptyState
          icon={<TargetIcon size={32} />}
          title="Set some targets first"
          hint="Head to the Skills tab and choose a target level for the skills that matter most."
        />
      ) : gaps.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={32} />}
          title="No gaps right now — nicely done!"
          hint="Stretch your targets in the Skills tab if you want a new challenge."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {gaps.map((g) => (
            <Card key={g.skill.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, marginBottom: 12 }}>
                <div>
                  <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a' }}>{g.skill.name}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Pill bg="#f1f5f9" fg="#475569">{g.skill.category}</Pill>
                    <span style={{ fontFamily: FONT, fontSize: 12, color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      Level <strong style={{ color: '#0f172a' }}>{g.current}</strong>
                      <ArrowRight size={12} />
                      <strong style={{ color: '#0e7fe0' }}>{g.target}</strong>
                    </span>
                    <Pill bg="#fef3c7" fg="#92400e">Gap of {g.gap}</Pill>
                  </div>
                </div>
                <Button variant="accent" disabled={busyId === g.skill.id} onClick={() => turnIntoObjective(g)}>
                  Make it an objective
                </Button>
              </div>

              <div style={{ marginTop: 8, padding: 14, background: '#f8fafc', borderRadius: 10 }}>
                <div style={{ fontFamily: FONT, fontSize: 11, fontWeight: 700, color: '#0e7fe0', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <BookOpen size={12} /> Suggested next steps
                </div>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {suggestionsFor(g.skill.name).map((s, i) => (
                    <li key={i} style={{ fontFamily: FONT, fontSize: 13, color: '#1e293b', lineHeight: 1.5, display: 'flex', gap: 8 }}>
                      <span style={{ color: '#0e7fe0' }}>→</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
