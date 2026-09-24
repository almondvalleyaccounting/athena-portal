import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { NOMINAL_ROLES, addNominalMapping } from './api';
import { font, card, th, td, btn, btnQuiet, Pill, ErrorBar } from './wpShared';

/*
 * Working Papers → map the book.
 *
 * The per-client mapping screen is correct and stays. It is also one client at a
 * time, and wp_nominal_map held FIVE ROWS for ONE client against 134 linked
 * QuickBooks files — so every paper that needs a nominal was blocked on work
 * nobody was going to do 134 times.
 *
 * THIS IS NOT NAME MATCHING. The per-client screen says why that is a trap and
 * it is right: "PAYE" appears as a control account, as an employer-NIC expense
 * line, and in one file as a bank account somebody created by mistake. These
 * proposals come from AccountSubType, which QuickBooks sets ITSELF when a
 * feature is switched on. Nobody types it and it does not drift.
 *
 * Measured across 127 charts, 22 Sep 2026:
 *
 *   cis_suffered  WithholdingAssetAmount      24 realms, one account each  100%
 *   cis_withheld  WithholdingLiabilityAmount  24 realms, one account each  100%
 *   vat_control   GlobalTaxPayable            89 exact, 2 ambiguous         98%
 *   ct_liability  CurrentTaxLiability         92 exact, 11 ambiguous        90%
 *
 * WHY PAYE AND NET WAGES ARE NEVER OFFERED IN BULK. PayrollTaxPayable averages
 * three accounts per file and they are DIFFERENT CREDITORS, not one control in
 * pieces: "Tax and National Insurance" (62 files, the one we want), "Total
 * Pension Contributions" (36, owed to the pension provider), "Attachment Order
 * Deductions" (37, court orders), "Other Deductions" (38). Accepting the
 * sub-type in bulk would post pensions and attachment orders into the PAYE
 * liability and the paper would still look balanced. So those two are a picker.
 *
 * AND THE PICKER IS MULTI-SELECT, because many-to-one is normal here: a file
 * that splits employee tax from employer NIC has two nominals in paye_control
 * and the paper sums them. One dropdown would quietly lose half the balance.
 */

const ROLE_LABEL = Object.fromEntries(NOMINAL_ROLES.map((r) => [r.role, r.label]));
const AUTO_ROLES = ['cis_suffered', 'cis_withheld', 'vat_control', 'ct_liability'];

export default function NominalMapBulk() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [role, setRole] = useState('cis_suffered');
  const [picked, setPicked] = useState({});   // `${entity_id}|${role}` -> Set(accountId)

  const load = useCallback(() => {
    setLoading(true);
    // 420 rows today. The explicit limit is the module rule rather than a guess:
    // PostgREST caps a fetch at around a thousand and truncates SILENTLY.
    supabase.from('v_wp_nominal_proposals').select('*').limit(2000)
      .then(({ data, error: e }) => {
        if (e) setError(e.message); else { setRows(data || []); setError(''); }
        setLoading(false);
      });
  }, []);
  useEffect(load, [load]);

  const forRole = useMemo(() => rows.filter((r) => r.role === role), [rows, role]);
  const auto    = useMemo(() => forRole.filter((r) => r.status === 'auto'), [forRole]);
  const choose  = useMemo(() => forRole.filter((r) => r.status === 'choose'), [forRole]);
  const mapped  = useMemo(() => forRole.filter((r) => r.status === 'mapped'), [forRole]);

  const counts = useMemo(() => {
    const by = {};
    for (const r of rows) {
      by[r.role] ??= { auto: 0, choose: 0, mapped: 0 };
      by[r.role][r.status] = (by[r.role][r.status] || 0) + 1;
    }
    return by;
  }, [rows]);

  const acceptAll = async () => {
    if (!auto.length) return;
    setBusy(`Accepting ${auto.length}…`);
    try {
      // Sequential on purpose. A partial failure should leave a partial, correct
      // map rather than an unknown one, and 92 inserts is not worth a race.
      for (const r of auto) {
        await addNominalMapping({
          entityId: r.entity_id, role: r.role,
          accountId: r.top_account_id, accountName: r.top_account_name,
          note: 'Proposed from QuickBooks AccountSubType, accepted in bulk',
        });
      }
      load();
    } catch (e) { setError(e.message); }
    setBusy('');
  };

  const acceptOne = async (r, accountId, accountName) => {
    setBusy(`${r.entity_name}…`);
    try {
      await addNominalMapping({
        entityId: r.entity_id, role: r.role, accountId, accountName,
        note: 'Chosen from the QuickBooks sub-type shortlist',
      });
      load();
    } catch (e) { setError(e.message); }
    setBusy('');
  };

  const acceptPicked = async (r) => {
    const key = `${r.entity_id}|${r.role}`;
    const set = picked[key];
    if (!set || set.size === 0) return;
    setBusy(`${r.entity_name}…`);
    try {
      for (const id of set) {
        const c = (r.candidates || []).find((x) => x.account_id === id);
        if (c) {
          await addNominalMapping({
            entityId: r.entity_id, role: r.role,
            accountId: c.account_id, accountName: c.name,
            note: 'Chosen from the QuickBooks sub-type shortlist',
          });
        }
      }
      setPicked((p) => ({ ...p, [key]: new Set() }));
      load();
    } catch (e) { setError(e.message); }
    setBusy('');
  };

  const toggle = (r, accountId) => {
    const key = `${r.entity_id}|${r.role}`;
    setPicked((p) => {
      const next = new Set(p[key] || []);
      if (next.has(accountId)) next.delete(accountId); else next.add(accountId);
      return { ...p, [key]: next };
    });
  };

  const isAuto = AUTO_ROLES.includes(role);

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 14, color: '#64748b', maxWidth: 940, marginTop: 0, marginBottom: 6, lineHeight: 1.55 }}>
        Map every client at once, using QuickBooks&rsquo; account types.
      </p>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 940, marginTop: 0, marginBottom: 14, lineHeight: 1.6 }}>
        <b>PAYE and net wages are never offered in bulk.</b> Their sub-types hold several different
        creditors per file — pension contributions and attachment orders sit alongside the HMRC
        liability — so accepting them wholesale would post the wrong money to the right-looking account.
        Those two are a shortlist, and you can pick <b>more than one</b>: a file splitting employee tax
        from employer NIC has two nominals in the PAYE role and the paper sums them.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {NOMINAL_ROLES.filter((r) => counts[r.role]).map((r) => {
          const c = counts[r.role] || {};
          const active = role === r.role;
          return (
            <button key={r.role} onClick={() => setRole(r.role)}
              style={{ ...(active ? btn : btnQuiet), fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {r.label}
              {c.auto ? <Pill colour="#15803d">{c.auto} ready</Pill> : null}
              {c.choose ? <Pill colour="#b45309">{c.choose} to pick</Pill> : null}
              {c.mapped ? <Pill colour="#64748b">{c.mapped} done</Pill> : null}
            </button>
          );
        })}
        <button onClick={load} style={{ ...btnQuiet, marginLeft: 'auto', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <RefreshCw size={12} /> Reload
        </button>
      </div>

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 14, padding: 24 }}>Loading proposals…</div>
      ) : (
        <>
          {isAuto && auto.length > 0 && (
            <div style={{ ...card, padding: 14, marginBottom: 12, display: 'flex',
                          alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13.5, color: '#0f172a', lineHeight: 1.5, flex: 1, minWidth: 320 }}>
                <b>{auto.length} client{auto.length === 1 ? '' : 's'}</b> have exactly one account typed
                as <code style={{ fontSize: 12.5 }}>{ROLE_LABEL[role]}</code> by QuickBooks. Nothing is
                being inferred from a name, and each mapping records who accepted it.
              </div>
              <button onClick={acceptAll} disabled={!!busy} style={{ ...btn, fontSize: 13.5 }}>
                <Check size={13} style={{ marginRight: 5 }} />
                {busy || `Accept all ${auto.length}`}
              </button>
            </div>
          )}

          {choose.length > 0 && (
            <div style={{ ...card, marginBottom: 12 }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid #f1f5f9', fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>
                {choose.length} need{choose.length === 1 ? 's' : ''} a choice
                <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 8 }}>
                  {isAuto ? 'more than one account carries this type' : 'shortlisted by type, ranked, you decide'}
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11 }}>
                      <th style={{ ...th, width: 230 }}>Client</th>
                      <th style={th}>Candidates in their QuickBooks</th>
                      <th style={{ ...th, width: 120 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {choose.map((r) => {
                      const key = `${r.entity_id}|${r.role}`;
                      const sel = picked[key] || new Set();
                      return (
                        <tr key={key} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={{ ...td, verticalAlign: 'top', fontWeight: 500 }}>{r.entity_name}</td>
                          <td style={td}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {(r.candidates || []).map((c) => {
                                const on = sel.has(c.account_id);
                                return (
                                  <button key={c.account_id} onClick={() => toggle(r, c.account_id)}
                                    title={c.sub_type}
                                    style={{ fontFamily: font, fontSize: 12.5, padding: '3px 9px',
                                             borderRadius: 999, cursor: 'pointer',
                                             border: `1px solid ${on ? '#15803d' : '#e2e8f0'}`,
                                             background: on ? '#f0fdf4' : '#fff',
                                             color: on ? '#15803d' : '#475569',
                                             fontWeight: on ? 600 : 400 }}>
                                    {on && <Check size={10} style={{ marginRight: 4, verticalAlign: -1 }} />}
                                    {c.name}
                                  </button>
                                );
                              })}
                            </div>
                          </td>
                          <td style={{ ...td, textAlign: 'right', verticalAlign: 'top' }}>
                            <button onClick={() => acceptPicked(r)} disabled={!!busy || sel.size === 0}
                              style={{ ...(sel.size ? btn : btnQuiet), fontSize: 12.5,
                                       opacity: sel.size ? 1 : 0.45,
                                       cursor: sel.size ? 'pointer' : 'default' }}>
                              Map {sel.size || ''}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {isAuto && auto.length > 0 && (
            <div style={card}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid #f1f5f9', fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>
                Ready to accept
                <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 8 }}>
                  one typed candidate each — accept individually if you would rather check as you go
                </span>
              </div>
              <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <tbody>
                    {auto.map((r) => (
                      <tr key={`${r.entity_id}|${r.role}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ ...td, width: 230, fontWeight: 500 }}>{r.entity_name}</td>
                        <td style={{ ...td, color: '#64748b' }}>
                          <ChevronRight size={11} style={{ verticalAlign: -1, color: '#cbd5e1' }} />
                          {' '}{r.top_account_name}
                        </td>
                        <td style={{ ...td, textAlign: 'right', width: 120 }}>
                          <button onClick={() => acceptOne(r, r.top_account_id, r.top_account_name)}
                            disabled={!!busy} style={{ ...btnQuiet, fontSize: 12.5 }}>
                            Map
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {mapped.length > 0 && (
            <div style={{ fontSize: 12.5, color: '#94a3b8', marginTop: 12, lineHeight: 1.6 }}>
              {mapped.length} client{mapped.length === 1 ? '' : 's'} already mapped for this role.
              Change one on the per-client screen, where a mapping can also be removed or its sign flipped.
            </div>
          )}

          {forRole.length === 0 && (
            <div style={{ ...card, padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
              No client&rsquo;s QuickBooks carries an account typed for this role.
            </div>
          )}
        </>
      )}
    </div>
  );
}
