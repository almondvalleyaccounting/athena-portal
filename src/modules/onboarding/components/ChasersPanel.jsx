import React, { useEffect, useState } from 'react';
import { Mail, ChevronDown, ChevronRight, Play, FlaskConical } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { supabase } from '../../../lib/supabase';
import { getChaseConfig, setChaseConfig, runChaseDryRun, runChaseTestSend } from '../api';

// Reviewed release: send the client chasers for the specific onboardings the
// admin has just reviewed in the dry-run panel. The explicit selection is the
// safety gate — sending_enabled stays off, digests are skipped. (Lives here
// rather than api.js while that file is mid-flight in another workstream.)
async function runChaseSendSelected(onboardingIds) {
  const { data, error } = await supabase.functions.invoke('onboarding-chase', {
    body: { dry_run: false, send_onboarding_ids: onboardingIds },
  });
  if (error) throw error;
  if (data && data.success === false) throw new Error(data.error || 'Send failed');
  return data;
}

const font = "'Outfit', sans-serif";

/*
  Admin-only panel controlling the onboarding-chase edge function.
  Sending stays OFF until explicitly armed here; dry run and single-address
  test sends work regardless so the flow can be trusted before going live.
*/
export default function ChasersPanel() {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState(null);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [msg, setMsg] = useState(null);
  const [selected, setSelected] = useState({}); // onboarding_id -> true (reviewed-release picks)

  useEffect(() => {
    getChaseConfig().then(setCfg).catch((e) => setMsg({ tone: 'danger', text: e.message }));
  }, []);

  async function toggleSending() {
    const next = !cfg.sending_enabled;
    if (next && !window.confirm('Arm the onboarding chasers? Clients with overdue items will start receiving real emails on the daily run.')) return;
    setCfg((c) => ({ ...c, sending_enabled: next }));
    try {
      await setChaseConfig({ sending_enabled: next });
      setMsg({ tone: next ? 'success' : 'neutral', text: next ? 'Chasers armed — real emails will send on the daily run.' : 'Chasers disarmed.' });
    } catch (e) {
      setCfg((c) => ({ ...c, sending_enabled: !next }));
      setMsg({ tone: 'danger', text: e.message });
    }
  }

  async function dryRun() {
    setBusy(true); setMsg(null); setSelected({});
    try {
      const data = await runChaseDryRun();
      setPlan(data);
      const n = (data.client_chases || []).length;
      setMsg({ tone: 'info', text: n === 0 ? 'Nothing due to chase today.' : `${n} client chaser${n === 1 ? '' : 's'} would go out — tick the ones to send now.` });
    } catch (e) { setMsg({ tone: 'danger', text: e.message }); }
    setBusy(false);
  }

  // Reviewed release: send exactly the ticked chasers, right now. The review
  // + explicit selection is the safety gate; the ARMED toggle stays off.
  async function sendSelected() {
    const ids = Object.keys(selected).filter((k) => selected[k]);
    if (!ids.length) return;
    const names = (plan?.client_chases || []).filter((c) => selected[c.onboarding_id]).map((c) => c.entity);
    if (!window.confirm(`Send ${ids.length} chaser email${ids.length === 1 ? '' : 's'} to client${ids.length === 1 ? '' : 's'} now?\n\n${names.join('\n')}`)) return;
    setBusy(true); setMsg(null);
    try {
      const data = await runChaseSendSelected(ids);
      const sent = (data.results || []).filter((r) => r.ok && r.kind === 'client_chase').length;
      setMsg({ tone: sent > 0 ? 'success' : 'warning', text: sent > 0 ? `Sent ${sent} chaser${sent === 1 ? '' : 's'}.` : 'Nothing sent — the selected chasers may no longer be due.' });
      setSelected({});
      const refreshed = await runChaseDryRun();
      setPlan(refreshed);
    } catch (e) { setMsg({ tone: 'danger', text: e.message }); }
    setBusy(false);
  }

  async function testSend() {
    if (!testEmail.includes('@')) { setMsg({ tone: 'danger', text: 'Enter a test email address first.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const data = await runChaseTestSend(testEmail);
      const sent = data.sent ?? 0;
      setMsg({ tone: sent > 0 ? 'success' : 'warning', text: sent > 0 ? `Sent ${sent} sample email${sent === 1 ? '' : 's'} to ${testEmail}.` : 'Nothing due today, so no sample was sent — set a step to "Waiting on client" with a requested date a few days back to test.' });
    } catch (e) { setMsg({ tone: 'danger', text: e.message }); }
    setBusy(false);
  }

  if (!cfg) return null;

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, marginBottom: 16, fontFamily: font }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', cursor: 'pointer' }}
      >
        {open ? <ChevronDown size={15} color="#94a3b8" /> : <ChevronRight size={15} color="#94a3b8" />}
        <Mail size={15} color="#64748b" />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>Automated chasers</span>
        <span style={chipStyle(cfg.sending_enabled ? 'success' : 'neutral')}>
          {cfg.sending_enabled ? 'ARMED' : 'OFF'}
        </span>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>
          clients nudged after {cfg.first_chase_after_days}d, then every {cfg.chase_every_days}d, max {cfg.max_chases} — owners get a daily digest
        </span>
      </div>

      {open && (
        <div style={{ padding: '0 18px 16px 43px' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <button
              onClick={dryRun} disabled={busy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font, background: tones.info.bg, color: tones.info.fg, border: `1px solid ${tones.info.border}`, borderRadius: 8, cursor: 'pointer' }}
            >
              <Play size={13} /> {busy ? 'Working…' : 'Preview today’s run (dry)'}
            </button>
            <input
              value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="test@… for sample send"
              style={{ padding: '7px 10px', fontSize: 12.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, minWidth: 200 }}
            />
            <button
              onClick={testSend} disabled={busy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font, background: tones.warning.bg, color: tones.warning.fg, border: `1px solid ${tones.warning.border}`, borderRadius: 8, cursor: 'pointer' }}
            >
              <FlaskConical size={13} /> Send samples to me
            </button>
            <button
              onClick={toggleSending}
              style={{ marginLeft: 'auto', padding: '7px 14px', fontSize: 12.5, fontWeight: 700, fontFamily: font, borderRadius: 8, cursor: 'pointer', background: cfg.sending_enabled ? tones.danger.bg : tones.success.solid, color: cfg.sending_enabled ? tones.danger.fg : '#fff', border: cfg.sending_enabled ? `1px solid ${tones.danger.border}` : 'none' }}
            >
              {cfg.sending_enabled ? 'Disarm chasers' : 'Arm chasers'}
            </button>
          </div>

          {msg && <div style={{ fontSize: 12.5, color: tones[msg.tone].fg, marginBottom: 8 }}>{msg.text}</div>}

          {plan && (plan.client_chases?.length > 0 || plan.digests?.length > 0) && (
            <div style={{ fontSize: 12.5, color: '#334155', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {plan.client_chases?.map((c, i) => (
                <label key={c.onboarding_id || i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', cursor: c.onboarding_id && c.to ? 'pointer' : 'default' }}>
                  {c.onboarding_id && c.to && (
                    <input
                      type="checkbox"
                      checked={!!selected[c.onboarding_id]}
                      onChange={(e) => setSelected((s) => ({ ...s, [c.onboarding_id]: e.target.checked }))}
                      style={{ marginTop: 2, flexShrink: 0 }}
                    />
                  )}
                  <div>
                    <strong>{c.entity}</strong> → {c.to || <span style={{ color: tones.danger.fg }}>no email on file</span>}
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {c.steps.map((s, j) => <li key={j}>{s.ask} <span style={{ color: '#94a3b8' }}>(chase #{s.chase_number})</span></li>)}
                    </ul>
                  </div>
                </label>
              ))}
              {Object.values(selected).some(Boolean) && (
                <button
                  onClick={sendSelected} disabled={busy}
                  style={{ alignSelf: 'flex-start', padding: '7px 14px', fontSize: 12.5, fontWeight: 700, fontFamily: font, background: tones.success.solid, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
                >
                  {busy ? 'Sending…' : `Send ${Object.values(selected).filter(Boolean).length} selected now`}
                </button>
              )}
              {plan.digests?.map((d, i) => (
                <div key={i} style={{ color: '#64748b' }}>
                  Digest → {d.owner} ({d.to || 'no email'}): {d.chasers} chasers, {d.overdue_external} overdue external, {d.non_responsive} non-responsive, {d.no_email} missing email
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
