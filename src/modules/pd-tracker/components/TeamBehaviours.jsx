import React from 'react';
import { Card, FONT, SERIF } from './ui';

// Almond Valley "Team Behaviours — Do's and Don'ts". Applies to everyone,
// so it's shown once on My Role rather than duplicated per role profile.
const BEHAVIOURS = [
  { category: 'Ownership & Follow-Through', items: [
    { do: "If you touch it, own it until it's done or properly handed over.", dont: "Leave something half-finished and assume someone else will pick it up." },
    { do: "Flag a problem early — the moment you know something's going to miss a deadline or needs help.", dont: "Sit on it hoping it sorts itself out, then escalate in a panic." },
  ]},
  { category: 'Client Communication', items: [
    { do: "Chase promptly and consistently — if a client owes you information, follow up on the date you said you would.", dont: "Let a request go quiet for weeks then blame the client for not responding." },
    { do: "Be clear and specific when asking clients for information — tell them exactly what you need, why, and by when.", dont: "Send vague emails that create more questions than they answer." },
    { do: "Keep your tone professional and helpful, even when a client is frustrating you.", dont: "Let irritation show in emails or calls — they're paying us, and tone is reputation." },
  ]},
  { category: 'Quality & Accuracy', items: [
    { do: "Check your own work before it goes anywhere — a five-minute review catches most mistakes.", dont: "Treat the reviewer as your spellchecker or safety net." },
    { do: "Follow the process, even when you think you know a shortcut.", dont: "Skip steps because “it's only a small client” — small clients get the same standard." },
  ]},
  { category: 'Team & Communication', items: [
    { do: "Ask if you're unsure — there's no penalty for not knowing, only for guessing and getting it wrong.", dont: "Bluff your way through something you're not confident on." },
    { do: "Share what you've learned — if you figure out a better way to do something, tell the team.", dont: "Hoard knowledge or assume everyone already knows what you know." },
    { do: "Respect other people's time — if you need help, prepare your question before interrupting someone.", dont: "Tap someone on the shoulder every ten minutes with half-formed thoughts." },
  ]},
  { category: 'Interaction With Each Other', items: [
    { do: "Treat everyone in the team with respect, regardless of role or experience.", dont: "Talk down to someone because they're newer or in a junior role." },
    { do: "Deal with disagreements or frustrations directly and privately with the person involved.", dont: "Vent about a colleague to other team members — it poisons the atmosphere and solves nothing." },
    { do: "Give feedback with the intention of helping, not scoring points.", dont: "Criticise someone's work in front of others — if something needs corrected, do it one-to-one." },
    { do: "Acknowledge when someone helps you or does good work — it costs nothing and it matters.", dont: "Take other people's effort for granted or assume it's just their job." },
    { do: "Chase colleagues for updates when you need them — it's not rude to ask where something stands.", dont: "Demand an immediate answer or interrogate someone on why something isn't done — ask the question, give them space to come back to you." },
    { do: "Be honest. If you've made a mistake, say so. If you disagree, say so respectfully.", dont: "Avoid difficult conversations — silence breeds resentment and lets small issues become big ones." },
    { do: "Assume good intent. If something feels off, ask before you react.", dont: "Jump to conclusions about why someone did or didn't do something — there's usually context you don't have." },
  ]},
  { category: 'Professionalism & Standards', items: [
    { do: "Treat client data as if it were your own — lock screens, secure files, follow the process.", dont: "Leave sensitive information on screen, in print trays, or in unsecured locations." },
    { do: "Meet internal deadlines with the same urgency as statutory ones.", dont: "Treat internal deadlines as optional and only react when HMRC or Companies House is the driver." },
  ]},
];

export default function TeamBehaviours() {
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <h3 style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a', margin: 0 }}>Team behaviours</h3>
        <span style={{ fontFamily: FONT, fontSize: 12, color: '#94a3b8' }}>Do's and don'ts — for everyone, whatever your role.</span>
      </div>
      <Card>
        {BEHAVIOURS.map((group) => (
          <div key={group.category} style={{ marginBottom: 18 }}>
            <div style={{ fontFamily: FONT, fontSize: 12, fontWeight: 700, color: '#0e7fe0', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
              {group.category}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {group.items.map((it, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div style={{ background: '#f0fdf4', border: '1px solid #dcfce7', borderRadius: 8, padding: '8px 10px' }}>
                    <span style={tag('#166534', '#dcfce7')}>Do</span>
                    <span style={cell}>{it.do}</span>
                  </div>
                  <div style={{ background: '#fef2f2', border: '1px solid #fee2e2', borderRadius: 8, padding: '8px 10px' }}>
                    <span style={tag('#b91c1c', '#fee2e2')}>Don't</span>
                    <span style={cell}>{it.dont}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

const cell = { fontFamily: FONT, fontSize: 12.5, color: '#1e293b', lineHeight: 1.5 };
const tag = (c, bg) => ({ display: 'inline-block', fontFamily: FONT, fontSize: 10, fontWeight: 700, color: c, background: bg, borderRadius: 999, padding: '1px 8px', marginRight: 6, verticalAlign: 'middle' });
