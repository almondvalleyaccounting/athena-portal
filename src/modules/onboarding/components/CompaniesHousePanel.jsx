import React, { useState } from 'react';
import { Building2, RefreshCw, UserPlus, AlertTriangle } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import { runChLookup, addDirectorSa } from '../api';

const font = "'Outfit', sans-serif";

/*
  Companies House snapshot fetched at onboarding (ch-lookup edge fn):
  profile facts + the live director list, each with one-click SA layering.
*/
export default function CompaniesHousePanel({ ob, onChanged }) {
  const { profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const ch = ob.ch_data;
  const isCompany = ob.template?.code === 'company' || Boolean(ch);
  if (!isCompany) return null;

  async function lookup() {
    setBusy(true); setMsg(null);
    try {
      const r = await runChLookup(ob.id);
      setMsg({ tone: 'success', text: `Found ${r.company_number} — ${r.officers} active officer${r.officers === 1 ? '' : 's'}.` });
      onChanged?.();
    } catch (e) { setMsg({ tone: 'danger', text: e.message }); }
    setBusy(false);
  }

  async function addSa(name) {
    setBusy(true); setMsg(null);
    try {
      await addDirectorSa(ob, name, { actorId: profile?.id });
      setMsg({ tone: 'success', text: `SA steps added for ${name}.` });
      onChanged?.();
    } catch (e) { setMsg({ tone: 'danger', text: e.message }); }
    setBusy(false);
  }

  const p = ch?.profile;
  const existingSaGroups = new Set(
    (ob.steps || []).map((s) => s.group_name).filter((g) => g.startsWith('SA — ')));

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Building2 size={14} color="#64748b" />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Companies House
        </span>
        <button
          onClick={lookup} disabled={busy} title={ch ? 'Refresh from Companies House' : 'Look up now'}
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: '#0e7fe0', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: font, padding: 0 }}
        >
          <RefreshCw size={12} style={busy ? { animation: 'spin 1s linear infinite' } : undefined} /> {ch ? 'Refresh' : 'Look up'}
        </button>
      </div>

      {msg && <div style={{ fontSize: 12, color: tones[msg.tone].fg, marginBottom: 8 }}>{msg.text}</div>}

      {!ch && (
        <div style={{ fontSize: 12, color: '#94a3b8' }}>
          Not looked up yet — runs automatically on new company onboardings, or hit Look up.
        </div>
      )}

      {p && (
        <>
          <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.7 }}>
            <strong>{p.company_name}</strong> · {p.company_number}
            {p.company_status !== 'active' && (
              <span style={{ ...chipStyle('danger'), marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <AlertTriangle size={9} /> {p.company_status}
              </span>
            )}
            <br />Incorporated {p.date_of_creation}
            {p.accounts_next_due && <><br />Accounts due {p.accounts_next_due}</>}
            {p.confirmation_statement_next_due && <><br />Confirmation stmt due {p.confirmation_statement_next_due}</>}
            {p.registered_office && <><br /><span style={{ color: '#94a3b8' }}>{p.registered_office}</span></>}
          </div>

          {(ch.officers || []).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                Directors
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {ch.officers.map((o) => {
                  const hasSa = existingSaGroups.has(`SA — ${o.name}`);
                  return (
                    <div key={o.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155' }}>
                      <span style={{ flex: 1 }}>{o.name}</span>
                      {hasSa
                        ? <span style={chipStyle('success')}>SA added</span>
                        : (
                          <button
                            onClick={() => addSa(o.name)} disabled={busy}
                            title={`Add self-assessment steps for ${o.name}`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: tones.info.bg, color: tones.info.fg, border: `1px solid ${tones.info.border}`, borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: font, padding: '3px 10px' }}
                          >
                            <UserPlus size={10} /> Add SA
                          </button>
                        )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
