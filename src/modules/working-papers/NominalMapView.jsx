import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Trash2, ArrowLeftRight, Search } from 'lucide-react';
import {
  NOMINAL_ROLES, fetchNominalMap, fetchQboChart, addNominalMapping,
  removeNominalMapping, setMappingSign, pullQboChart,
} from './api';
import {
  font, card, th, thNum, td, tdNum, inputStyle, btn, btnQuiet,
  money, Pill, ErrorBar, dateTime,
} from './wpShared';

/*
 * Working Papers → the nominal mapping.
 *
 * The bridge between a working-paper ROLE ("PAYE control") and a nominal in ONE
 * client's QuickBooks file. It exists because there is no house chart of
 * accounts across the portfolio and there never will be — these are the
 * clients' own files, set up by whoever set them up.
 *
 * WHY THIS IS NOT AUTOMATIC. Name matching was tried in the fee-engine service
 * mapping and it is a trap here: "PAYE" alone appears as a control account, as
 * an expense line for employer NIC, and in at least one file as a bank account
 * somebody created by mistake. Mapping the wrong one produces a paper that
 * reconciles to the wrong number and looks fine. A human picks, once, per
 * client, and the pick is recorded with who made it.
 *
 * MANY-TO-ONE IS NORMAL. A file that splits employee tax from employer NIC has
 * two nominals in the PAYE control role and the paper sums them. That is why
 * this screen lists mappings under a role rather than offering one dropdown per
 * role — one dropdown would have quietly forced a choice that loses half the
 * balance.
 */

const KEY_ROLES = ['paye_control', 'cis_suffered', 'cis_withheld'];

export default function NominalMapView({ entity }) {
  const [mappings, setMappings] = useState([]);
  const [chart, setChart] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pulling, setPulling] = useState(false);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('paye_control');
  const [showAllRoles, setShowAllRoles] = useState(false);

  const realmId = entity?.realm_id || null;

  const load = useCallback(async () => {
    if (!entity?.entity_id) return;
    setLoading(true);
    setError(null);
    try {
      const [m, c] = await Promise.all([
        fetchNominalMap(entity.entity_id),
        realmId ? fetchQboChart(realmId) : Promise.resolve([]),
      ]);
      setMappings(m);
      setChart(c);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [entity?.entity_id, realmId]);

  useEffect(() => { load(); }, [load]);

  const refreshChart = async () => {
    if (!realmId) return;
    setPulling(true);
    setError(null);
    try {
      await pullQboChart(realmId);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setPulling(false);
    }
  };

  const mappedIds = useMemo(
    () => new Set(mappings.filter((m) => m.role === role).map((m) => m.qbo_account_id)),
    [mappings, role],
  );

  // Balance-sheet accounts first: every role on this screen except none of them
  // is a balance sheet control account, so a chart of 300 rows led by expense
  // codes buries the useful ones.
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    const scored = chart
      .filter((a) => a.active !== false)
      .filter((a) => !q
        || (a.fully_qualified || a.name || '').toLowerCase().includes(q)
        || (a.account_type || '').toLowerCase().includes(q))
      .map((a) => ({
        ...a,
        rank: /liabilit|asset|equity/i.test(a.classification || '') ? 0 : 1,
      }));
    scored.sort((a, b) => a.rank - b.rank
      || (a.fully_qualified || '').localeCompare(b.fully_qualified || ''));
    return scored.slice(0, 60);
  }, [chart, search]);

  const roles = showAllRoles ? NOMINAL_ROLES : NOMINAL_ROLES.filter((r) => KEY_ROLES.includes(r.role));

  const add = async (account) => {
    setError(null);
    try {
      await addNominalMapping({
        entityId: entity.entity_id,
        role,
        accountId: account.account_id,
        accountName: account.fully_qualified || account.name,
      });
      await load();
    } catch (e) { setError(e.message); }
  };

  const remove = async (id) => {
    setError(null);
    try { await removeNominalMapping(id); await load(); }
    catch (e) { setError(e.message); }
  };

  const flip = async (m) => {
    setError(null);
    try { await setMappingSign(m.id, m.sign === 1 ? -1 : 1); await load(); }
    catch (e) { setError(e.message); }
  };

  if (!entity) {
    return <p style={{ fontFamily: font, fontSize: 13, color: '#94a3b8' }}>Pick a client first.</p>;
  }

  if (!realmId) {
    return (
      <div style={{ ...card, padding: '14px 16px', borderColor: '#fed7aa', background: '#fff7ed' }}>
        <span style={{ fontFamily: font, fontSize: 12.5, color: '#c2410c' }}>
          <strong>{entity.entity_name} has no active QuickBooks connection.</strong> There is no chart of
          accounts to map against, so the QuickBooks leg of this client's papers cannot be prepared.
          Connect the file first (Settings → Connections), then come back.
        </span>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: font }}>
      <ErrorBar message={error} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: '#64748b' }}>
          Mapping <strong style={{ color: '#0f172a' }}>{entity.entity_name}</strong> against{' '}
          {entity.qbo_company || realmId} — {chart.length} account{chart.length === 1 ? '' : 's'} cached
          {chart.length === 0 && ' (pull the chart to begin)'}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={refreshChart} disabled={pulling} style={{ ...btnQuiet, display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={13} style={{ animation: pulling ? 'spin 1s linear infinite' : 'none' }} />
          {pulling ? 'Pulling…' : 'Pull chart from QuickBooks'}
        </button>
      </div>

      {/* ── Roles, and what is mapped to each ── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {roles.map((r) => {
          const count = mappings.filter((m) => m.role === r.role).length;
          const active = role === r.role;
          return (
            <button
              key={r.role}
              onClick={() => setRole(r.role)}
              title={r.hint}
              style={{
                padding: '6px 12px', fontSize: 12.5, fontFamily: font, cursor: 'pointer',
                borderRadius: 8, border: `1px solid ${active ? '#0e7fe0' : '#e5e7eb'}`,
                background: active ? '#eff6ff' : '#fff',
                color: active ? '#0e7fe0' : '#475569', fontWeight: active ? 600 : 400,
              }}
            >
              {r.label}
              {count > 0 && <span style={{ marginLeft: 6, opacity: 0.7 }}>({count})</span>}
            </button>
          );
        })}
        <button onClick={() => setShowAllRoles((v) => !v)} style={{ ...btnQuiet, padding: '6px 10px' }}>
          {showAllRoles ? 'Just the PAYE roles' : 'All roles'}
        </button>
      </div>

      <p style={{ fontSize: 12, color: '#64748b', marginBottom: 12, maxWidth: 760, lineHeight: 1.55 }}>
        {NOMINAL_ROLES.find((r) => r.role === role)?.hint}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14, alignItems: 'start' }}>
        {/* Mapped */}
        <div style={card}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid #e5e7eb', fontSize: 12.5, fontWeight: 600, color: '#0f172a' }}>
            Mapped to {NOMINAL_ROLES.find((r) => r.role === role)?.label}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: '#f8fafc' }}>
              <th style={th}>Nominal</th>
              <th style={thNum}>Sign</th>
              <th style={th} />
            </tr></thead>
            <tbody>
              {mappings.filter((m) => m.role === role).length === 0 && (
                <tr><td style={{ ...td, color: '#94a3b8' }} colSpan={3}>
                  Nothing mapped. Pick from the right — the paper cannot value this role until you do.
                </td></tr>
              )}
              {mappings.filter((m) => m.role === role).map((m) => (
                <tr key={m.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>
                    {m.qbo_account_name || m.qbo_account_id}
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>
                      id {m.qbo_account_id} · added {dateTime(m.created_at)}
                    </div>
                  </td>
                  <td style={tdNum}>
                    <button
                      onClick={() => flip(m)}
                      title="Flip the sign, where this file carries the role the other way round"
                      style={{ ...btnQuiet, padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      <ArrowLeftRight size={11} />{m.sign === 1 ? '+' : '−'}
                    </button>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => remove(m.id)} title="Unmap"
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#b91c1c' }}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Candidates */}
        <div style={card}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Search size={13} style={{ color: '#94a3b8' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the client's chart of accounts…"
              style={{ ...inputStyle, border: 'none', flex: 1, padding: '2px 0' }}
            />
          </div>
          <div style={{ maxHeight: 460, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#f8fafc' }}>
                <th style={th}>Account</th>
                <th style={thNum}>Balance now</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td style={{ ...td, color: '#94a3b8' }} colSpan={2}>Loading…</td></tr>}
                {!loading && candidates.length === 0 && (
                  <tr><td style={{ ...td, color: '#94a3b8' }} colSpan={2}>
                    {chart.length === 0
                      ? 'No chart cached for this file yet — pull it from QuickBooks above.'
                      : 'Nothing matches that search.'}
                  </td></tr>
                )}
                {candidates.map((a) => {
                  const already = mappedIds.has(a.account_id);
                  return (
                    <tr
                      key={a.account_id}
                      onClick={() => !already && add(a)}
                      style={{
                        borderTop: '1px solid #f1f5f9',
                        cursor: already ? 'default' : 'pointer',
                        opacity: already ? 0.45 : 1,
                      }}
                    >
                      <td style={td}>
                        {a.fully_qualified || a.name}
                        <div style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' }}>
                          <Pill>{a.account_type || 'unknown type'}</Pill>
                          {a.account_sub_type && <span>{a.account_sub_type}</span>}
                          {already && <span style={{ color: '#15803d', fontWeight: 600 }}>mapped</span>}
                        </div>
                      </td>
                      {/* "Balance now" is QuickBooks' CurrentBalance, which is
                          as-at-today and is NOT what the paper uses. It is here
                          only to help recognise the right account. */}
                      <td style={tdNum} title="QuickBooks' current balance — as at today, not the paper's date">
                        {money(a.current_balance)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
