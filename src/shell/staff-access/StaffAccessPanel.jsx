import React, { useEffect, useMemo, useState } from 'react';
import { Search, Lock, Copy, ShieldCheck } from 'lucide-react';
import { BTN } from '../../lib/buttonStyles';
import { brand, tones } from '../../lib/tokens';
import InDevelopmentTag from '../InDevelopmentTag';
import {
  FIGURE_MODULES, ABILITIES, SYSTEM_ABILITIES, LOCKED, NEEDS,
  buildSections, inDevelopmentKeys, allKeys, fullLabel, moduleLabel,
} from './accessCatalog';
import { staffAccess, loadAccessData, loadClients, loadClientAccess } from './staffAccessApi';

/*
  Staff & Permissions (sql/329, Bobby 2026-09-27): access by staff member, by
  module. One person at a time on the right, so the screen never becomes the
  old 21-column wall. Client figures are also switched per client, by hand, on
  the Clients tab. Portal admins see everything and can't be limited.

  Views:
    By person — pick someone; Modules tab (cards grouped like the sidebar) and
                Clients tab (search, filter, turn all shown on/off).
    By module — pick a module; everyone's switch for it in one column.
    In development — who's testing what, Release, and the new-client default.
*/

const font = "'Outfit', sans-serif";
const ink = '#0f172a';
const muted = '#64748b';
const faint = '#94a3b8';
const line = '#e5e7eb';

const displayName = (u) => u.name || u.email || 'Unknown';
const FORMER = new Set(['archived', 'nlac']);

// A callback ref, because the element it measures changes: the loading line
// first, then the panel.
function useWidth() {
  const [node, setNode] = useState(null);
  const [w, setW] = useState(1200);
  useEffect(() => {
    if (!node) return undefined;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  return [setNode, w];
}

export default function StaffAccessPanel({ users, onUsersChange, renderProfile }) {
  const [rootRef, width] = useWidth();
  // Below this the two columns stop fitting: the people (or modules) list
  // becomes a wrapping row of chips above the detail instead of a column.
  const narrow = width < 860;
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState('person');
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);

  const active = useMemo(() => users.filter((u) => u.is_active !== false), [users]);
  const inactive = useMemo(() => users.filter((u) => u.is_active === false), [users]);
  const selected = users.find((u) => u.id === selectedId) || active[0] || null;

  const reload = async () => {
    try { setData(await loadAccessData()); setLoadError(''); }
    catch (e) { setLoadError(String(e.message || e)); }
  };
  useEffect(() => { reload(); }, []);

  // One path for every write: call, then reload whatever it can have changed.
  // Module switches move the derived flags on staff_profiles too, so the
  // user list is refreshed as well.
  const run = async (tag, action, body, { users: refreshUsers = false } = {}) => {
    setBusy(tag); setError('');
    try {
      await staffAccess(action, body);
      await reload();
      if (refreshUsers) await onUsersChange();
    } catch (e) {
      setError(String(e.message || e));
    }
    setBusy(null);
  };

  if (loadError) {
    return <div ref={rootRef}><Notice tone="danger">Couldn't load access: {loadError}</Notice></div>;
  }
  if (!data) return <p ref={rootRef} style={{ fontFamily: font, fontSize: 14.5, color: faint }}>Loading access…</p>;

  const sections = buildSections(data.meta);

  return (
    <div ref={rootRef} style={{ fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'person', label: 'By person' },
            { value: 'module', label: 'By module' },
            { value: 'dev', label: `In development (${inDevelopmentKeys(data.meta).length})` },
          ]}
        />
        {error && <span style={{ fontSize: 13.5, color: tones.danger.fg }}>{error}</span>}
      </div>

      {view === 'person' && selected && (
        <div style={twoCol(narrow)}>
          <StaffList
            active={active} inactive={inactive} selectedId={selected.id} onSelect={setSelectedId}
            data={data} narrow={narrow}
          />
          <PersonView
            key={selected.id}
            user={selected} users={active} data={data} sections={sections}
            busy={busy} run={run} renderProfile={renderProfile}
          />
        </div>
      )}

      {view === 'module' && <ModuleView users={active} data={data} sections={sections} busy={busy} run={run} narrow={narrow} />}

      {view === 'dev' && <DevView users={active} data={data} busy={busy} run={run} />}
    </div>
  );
}

/* ─── Left: the team ─────────────────────────────────────────────────── */

function StaffList({ active, inactive, selectedId, onSelect, data, narrow }) {
  if (narrow) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {[...active, ...inactive].map((u) => {
          const on = u.id === selectedId;
          return (
            <button
              key={u.id}
              onClick={() => onSelect(u.id)}
              style={{
                fontFamily: font, fontSize: 13.5, fontWeight: on ? 600 : 500, cursor: 'pointer',
                padding: '5px 11px', borderRadius: 999,
                border: `1px solid ${on ? brand.solid : '#cbd5e1'}`,
                background: on ? brand.solid : '#fff', color: on ? brand.onSolid : '#334155',
                opacity: u.is_active === false ? 0.55 : 1,
              }}
            >
              {displayName(u).split(' ')[0]}{u.is_portal_admin ? ' · Admin' : ''}
            </button>
          );
        })}
      </div>
    );
  }
  const row = (u) => {
    const on = u.id === selectedId;
    const admin = u.is_portal_admin === true;
    const n = Object.keys(data.access[u.id] || {}).length;
    const c = data.counts[u.id];
    return (
      <button
        key={u.id}
        onClick={() => onSelect(u.id)}
        style={{
          display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
          padding: '9px 12px', borderRadius: 8, marginBottom: 2, fontFamily: font,
          background: on ? '#eef4f8' : 'transparent',
          boxShadow: on ? `inset 2px 0 0 ${brand.solid}` : 'none',
          opacity: u.is_active === false ? 0.55 : 1,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 14.5, fontWeight: on ? 600 : 500, color: ink }}>{displayName(u)}</span>
          {admin && <Chip tone="accent">Admin</Chip>}
        </div>
        <div style={{ fontSize: 12.5, color: faint, marginTop: 1 }}>
          {u.is_active === false ? 'Inactive'
            : admin ? 'Every module and client'
            : `${n} module${n === 1 ? '' : 's'} · ${c ? `${c.clients_on} of ${c.clients_total} clients` : 'no clients'}`}
        </div>
      </button>
    );
  };
  return (
    <div style={{ background: '#fff', border: `1px solid ${line}`, borderRadius: 12, padding: 6, position: 'sticky', top: 12 }}>
      {active.map(row)}
      {inactive.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: faint, padding: '10px 12px 4px' }}>Inactive</div>
          {inactive.map(row)}
        </>
      )}
    </div>
  );
}

/* ─── Right: one person ──────────────────────────────────────────────── */

function PersonView({ user, users, data, sections, busy, run, renderProfile }) {
  const [tab, setTab] = useState('modules');
  const admin = user.is_portal_admin === true;

  return (
    <div>
      <div style={{ background: '#fff', border: `1px solid ${line}`, borderRadius: 12, padding: '16px 20px', marginBottom: 14 }}>
        {renderProfile(user)}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14, paddingTop: 14, borderTop: `1px solid #f1f5f9`, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: '1 1 280px', minWidth: 0 }}>
            <Switch
              on={admin}
              busy={busy === `admin:${user.id}`}
              onChange={(v) => run(`admin:${user.id}`, 'set_admin', { staff_id: user.id, value: v }, { users: true })}
            />
            <span>
              <span style={{ fontSize: 14.5, fontWeight: 600, color: ink }}>Portal admin</span>
              <span style={{ display: 'block', fontSize: 13, color: muted }}>Sees every module and every client, and manages this screen.</span>
            </span>
          </label>
          {!admin && <CopyFrom user={user} users={users} busy={busy} run={run} />}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'modules', label: 'Modules' }, { value: 'clients', label: 'Clients' }]} />
      </div>

      {tab === 'modules'
        ? <ModulesTab user={user} data={data} sections={sections} busy={busy} run={run} />
        : <ClientsTab user={user} busy={busy} run={run} />}
    </div>
  );
}

function CopyFrom({ user, users, busy, run }) {
  const [from, setFrom] = useState('');
  const [what, setWhat] = useState('both');
  const tag = `copy:${user.id}`;
  const others = users.filter((u) => u.id !== user.id);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Copy size={14} style={{ color: faint }} />
      <select value={from} onChange={(e) => setFrom(e.target.value)} style={selectStyle}>
        <option value="">Copy access from…</option>
        {others.map((u) => <option key={u.id} value={u.id}>{displayName(u)}</option>)}
      </select>
      <select value={what} onChange={(e) => setWhat(e.target.value)} style={selectStyle}>
        <option value="both">Modules and clients</option>
        <option value="modules">Modules only</option>
        <option value="clients">Clients only</option>
      </select>
      <button
        disabled={!from || busy === tag}
        onClick={() => {
          const src = others.find((u) => u.id === from);
          if (!window.confirm(`Replace ${displayName(user)}'s ${what === 'both' ? 'modules and clients' : what} with ${displayName(src)}'s?`)) return;
          run(tag, 'copy_access', { from_staff_id: from, to_staff_id: user.id, what }, { users: true });
        }}
        style={{ ...BTN.secondary.sm, opacity: !from ? 0.5 : 1, cursor: !from ? 'not-allowed' : 'pointer' }}
      >
        {busy === tag ? 'Copying…' : 'Copy'}
      </button>
    </div>
  );
}

/* ─── Modules tab ────────────────────────────────────────────────────── */

function ModulesTab({ user, data, sections, busy, run }) {
  const admin = user.is_portal_admin === true;
  const mine = data.access[user.id] || {};

  const setModule = (key, level) => run(`mod:${user.id}:${key}`, 'set_module', { staff_id: user.id, module_key: key, level }, { users: true });
  const setAbility = (flag, value) => run(`ab:${user.id}:${flag}`, 'set_ability', { staff_id: user.id, flag, value }, { users: true });

  return (
    <>
      {admin && (
        <Notice tone="accent">
          <ShieldCheck size={15} style={{ verticalAlign: -3, marginRight: 6 }} />
          {displayName(user)} is a portal admin, so every module below is on and can't be switched off. Turn admin off to set modules one by one.
        </Notice>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: 12, opacity: admin ? 0.6 : 1, pointerEvents: admin ? 'none' : 'auto' }}>
        {sections.map((s) => (
          <Card key={s.section} title={s.section}>
            {s.rows.map((r, i) => {
              const inDev = data.meta[r.key]?.status === 'in_development';
              const has = admin || r.key in mine;
              const locked = LOCKED[r.key];
              return (
                <div key={r.key} style={{ borderTop: i ? '1px solid #f1f5f9' : 'none', padding: '9px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 14.5, color: ink, fontWeight: 500 }}>{r.label}</span>
                        {inDev && <InDevelopmentTag short />}
                        {FIGURE_MODULES.has(r.key) && <Chip tone="teal" title="Figures follow the Clients tab">per client</Chip>}
                      </div>
                      {(locked || NEEDS[r.key] || inDev) && (
                        <div style={{ fontSize: 12.5, color: faint, marginTop: 2 }}>
                          {locked || (inDev ? 'Only admins and testers see it' : '')}
                          {NEEDS[r.key] && !locked ? `${inDev ? ' · ' : ''}${NEEDS[r.key]}` : ''}
                        </div>
                      )}
                    </div>
                    {locked ? (
                      <Lock size={15} style={{ color: faint, flexShrink: 0 }} />
                    ) : r.key === 'billing' ? (
                      <Segmented
                        small
                        value={admin ? 'approver' : mine.billing || 'off'}
                        onChange={(v) => setModule('billing', v === 'off' ? null : v)}
                        options={[{ value: 'off', label: 'Off' }, { value: 'submitter', label: 'Submitter' }, { value: 'approver', label: 'Approver' }]}
                      />
                    ) : (
                      <Switch
                        on={has}
                        label={inDev ? 'Tester' : null}
                        busy={busy === `mod:${user.id}:${r.key}`}
                        onChange={(v) => setModule(r.key, v ? 'on' : null)}
                      />
                    )}
                  </div>

                  {has && (ABILITIES[r.key] || []).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 7, paddingLeft: 2 }}>
                      {ABILITIES[r.key].map((a) => (
                        <Tick
                          key={a.flag}
                          on={admin || user[a.flag] === true}
                          label={a.label}
                          busy={busy === `ab:${user.id}:${a.flag}`}
                          onChange={(v) => setAbility(a.flag, v)}
                        />
                      ))}
                    </div>
                  )}

                  {has && r.devChildren.length > 0 && (
                    <div style={{ marginTop: 8, padding: '6px 10px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8 }}>
                      <div style={{ fontSize: 12, color: '#92400e', marginBottom: 4 }}>In development: testers only</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
                        {r.devChildren.map((c) => (
                          <Tick
                            key={c.key}
                            on={admin || c.key in mine}
                            label={c.label}
                            busy={busy === `mod:${user.id}:${c.key}`}
                            onChange={(v) => setModule(c.key, v ? 'on' : null)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        ))}

        <Card title="Across modules">
          {SYSTEM_ABILITIES.map((a, i) => (
            <div key={a.flag} style={{ borderTop: i ? '1px solid #f1f5f9' : 'none', padding: '9px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div>
                <div style={{ fontSize: 14.5, color: ink, fontWeight: 500 }}>{a.label}</div>
                {a.hint && <div style={{ fontSize: 12.5, color: faint, marginTop: 2 }}>{a.hint}</div>}
              </div>
              <Switch
                on={admin || user[a.flag] === true}
                busy={busy === `ab:${user.id}:${a.flag}`}
                onChange={(v) => setAbility(a.flag, v)}
              />
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}

/* ─── Clients tab ────────────────────────────────────────────────────── */

let clientsCache = null; // the client list is the same for everyone; load it once

function ClientsTab({ user, busy, run }) {
  const admin = user.is_portal_admin === true;
  const [clients, setClients] = useState(clientsCache);
  const [access, setAccess] = useState(null);
  const [q, setQ] = useState('');
  const [manager, setManager] = useState('');
  const [show, setShow] = useState('all');
  const [former, setFormer] = useState(false);
  const [err, setErr] = useState('');

  const refresh = async () => {
    try {
      const [c, a] = await Promise.all([clientsCache ? clientsCache : loadClients(), loadClientAccess(user.id)]);
      clientsCache = c;
      setClients(c); setAccess(a); setErr('');
    } catch (e) { setErr(String(e.message || e)); }
  };
  useEffect(() => { refresh(); }, [user.id]);

  const managers = useMemo(() => [...new Set((clients || []).map((c) => c.manager).filter(Boolean))].sort(), [clients]);

  const shown = useMemo(() => {
    if (!clients || !access) return [];
    const needle = q.trim().toLowerCase();
    return clients.filter((c) => {
      if (!former && FORMER.has(c.entity_status)) return false;
      if (manager && c.manager !== manager) return false;
      if (needle && !(c.name || '').toLowerCase().includes(needle)) return false;
      const on = access[c.id] === true;
      if (show === 'on' && !on) return false;
      if (show === 'off' && on) return false;
      return true;
    });
  }, [clients, access, q, manager, show, former]);

  if (admin) return <Notice tone="accent">Portal admins see every client's figures.</Notice>;
  if (err) return <Notice tone="danger">{err}</Notice>;
  if (!clients || !access) return <p style={{ fontSize: 14, color: faint }}>Loading clients…</p>;

  const onCount = shown.filter((c) => access[c.id] === true).length;
  const setMany = async (ids, enabled, tag) => {
    // Optimistic: flip locally, then refetch the truth.
    setAccess((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, enabled])) }));
    await run(tag, 'set_clients', { staff_id: user.id, entity_ids: ids, enabled });
    await refresh();
  };
  const bulk = (enabled) => {
    const ids = shown.filter((c) => (access[c.id] === true) !== enabled).map((c) => c.id);
    if (ids.length === 0) return;
    if (ids.length > 25 && !window.confirm(`Turn ${enabled ? 'on' : 'off'} ${ids.length} clients for ${displayName(user)}?`)) return;
    setMany(ids, enabled, `bulk:${user.id}`);
  };

  return (
    <div style={{ background: '#fff', border: `1px solid ${line}`, borderRadius: 12, padding: 16 }}>
      <p style={{ fontSize: 13.5, color: muted, margin: '0 0 12px' }}>
        A client switched off hides only its figures (dashboard, portfolio, reports, working papers, HMRC and fees). Its name, tasks, deadlines and messages stay visible.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ position: 'relative', flex: '1 1 220px' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: faint }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients" style={{ ...inputStyle, paddingLeft: 30 }} />
        </div>
        <select value={manager} onChange={(e) => setManager(e.target.value)} style={selectStyle}>
          <option value="">Any manager</option>
          {managers.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={show} onChange={(e) => setShow(e.target.value)} style={selectStyle}>
          <option value="all">On and off</option>
          <option value="on">On only</option>
          <option value="off">Off only</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: muted }}>
          <input type="checkbox" checked={former} onChange={(e) => setFormer(e.target.checked)} /> Former clients
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 13, color: muted, marginBottom: 6, flexWrap: 'wrap' }}>
        <span>{shown.length} shown · {onCount} on</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => bulk(true)} disabled={busy === `bulk:${user.id}`} style={BTN.secondary.sm}>Turn all shown on</button>
          <button onClick={() => bulk(false)} disabled={busy === `bulk:${user.id}`} style={BTN.secondary.sm}>Turn all shown off</button>
        </span>
      </div>
      <div style={{ maxHeight: 460, overflowY: 'auto', border: `1px solid #f1f5f9`, borderRadius: 8 }}>
        {shown.length === 0 && <div style={{ padding: 16, fontSize: 14, color: faint }}>No clients match.</div>}
        {shown.map((c) => {
          const on = access[c.id] === true;
          return (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 12px', borderBottom: '1px solid #f8fafc' }}>
              <span style={{ fontSize: 14, color: on ? ink : faint, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.name}
                {FORMER.has(c.entity_status) && <span style={{ fontSize: 12, color: faint }}> · former</span>}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                <span style={{ fontSize: 12.5, color: faint }}>{c.manager || '—'}</span>
                <Switch on={on} onChange={(v) => setMany([c.id], v, `cl:${user.id}:${c.id}`)} busy={busy === `cl:${user.id}:${c.id}`} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── By module ──────────────────────────────────────────────────────── */

function ModuleView({ users, data, sections, busy, run, narrow }) {
  const keys = sections.flatMap((s) => s.rows.flatMap((r) => [r, ...r.devChildren.map((c) => ({ ...c, child: true }))]));
  const [key, setKey] = useState(keys[0]?.key);
  const inDev = data.meta[key]?.status === 'in_development';
  const locked = LOCKED[key];

  return (
    <div style={twoCol(narrow)}>
      {narrow ? (
        <select value={key} onChange={(e) => setKey(e.target.value)} style={{ ...selectStyle, fontSize: 14.5, padding: '8px 12px' }}>
          {keys.map((k) => <option key={k.key} value={k.key}>{k.child ? '   ' : ''}{fullLabel(k.key)}</option>)}
        </select>
      ) : (
      <div style={{ background: '#fff', border: `1px solid ${line}`, borderRadius: 12, padding: 6, maxHeight: 640, overflowY: 'auto' }}>
        {keys.map((k) => (
          <button
            key={k.key}
            onClick={() => setKey(k.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
              padding: k.child ? '6px 12px 6px 26px' : '8px 12px', borderRadius: 8, fontFamily: font,
              fontSize: k.child ? 13.5 : 14.5, color: ink, fontWeight: k.key === key ? 600 : 400,
              background: k.key === key ? '#eef4f8' : 'transparent',
            }}
          >
            {k.label}
            {data.meta[k.key]?.status === 'in_development' && <span style={{ marginLeft: 'auto' }}><InDevelopmentTag short /></span>}
          </button>
        ))}
      </div>
      )}

      <Card title={fullLabel(key)}>
        {locked && <div style={{ fontSize: 13.5, color: muted, padding: '6px 0' }}>{locked}</div>}
        {inDev && <div style={{ fontSize: 13.5, color: muted, padding: '6px 0' }}>In development: only admins and the testers ticked here see it.</div>}
        {users.map((u, i) => {
          const admin = u.is_portal_admin === true;
          const lvl = data.access[u.id]?.[key];
          const c = data.counts[u.id];
          return (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderTop: i ? '1px solid #f1f5f9' : 'none' }}>
              <div>
                <span style={{ fontSize: 14.5, color: ink, fontWeight: 500 }}>{displayName(u)}</span>
                {admin && <span style={{ marginLeft: 6 }}><Chip tone="accent">Admin</Chip></span>}
                {FIGURE_MODULES.has(key) && !admin && c && (
                  <span style={{ fontSize: 12.5, color: faint, marginLeft: 8 }}>{c.clients_on} of {c.clients_total} clients</span>
                )}
              </div>
              {admin || locked ? (
                <span style={{ fontSize: 13, color: faint }}>{admin ? 'Always' : '—'}</span>
              ) : key === 'billing' ? (
                <Segmented
                  small value={lvl || 'off'}
                  onChange={(v) => run(`mod:${u.id}:${key}`, 'set_module', { staff_id: u.id, module_key: key, level: v === 'off' ? null : v }, { users: true })}
                  options={[{ value: 'off', label: 'Off' }, { value: 'submitter', label: 'Submitter' }, { value: 'approver', label: 'Approver' }]}
                />
              ) : (
                <Switch
                  on={!!lvl} label={inDev ? 'Tester' : null}
                  busy={busy === `mod:${u.id}:${key}`}
                  onChange={(v) => run(`mod:${u.id}:${key}`, 'set_module', { staff_id: u.id, module_key: key, level: v ? 'on' : null }, { users: true })}
                />
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

/* ─── In development ─────────────────────────────────────────────────── */

function DevView({ users, data, busy, run }) {
  const dev = inDevelopmentKeys(data.meta);
  const [back, setBack] = useState('');
  const live = allKeys().filter((k) => data.meta[k] && data.meta[k].status !== 'in_development');
  const testers = (key) => users.filter((u) => u.is_portal_admin !== true && data.access[u.id]?.[key]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: 12, alignItems: 'start' }}>
      <Card title="In development">
        <p style={{ fontSize: 13.5, color: muted, margin: '0 0 6px' }}>
          Hidden from everyone except admins and the testers ticked on each person's Modules tab. Release a module when it's ready to rely on.
        </p>
        {dev.map((k, i) => {
          const t = testers(k);
          return (
            <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderTop: i ? '1px solid #f1f5f9' : 'none' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14.5, color: ink, fontWeight: 500 }}>{fullLabel(k)}</div>
                <div style={{ fontSize: 12.5, color: faint }}>{t.length ? `Testers: ${t.map(displayName).join(', ')}` : 'No testers'}</div>
              </div>
              <button
                disabled={busy === `st:${k}`}
                onClick={() => {
                  const note = data.meta[k]?.grantable
                    ? `Release ${fullLabel(k)}? Its testers keep it, and you then switch it on for anyone else who should have it.`
                    : `Release ${fullLabel(k)}? Everyone with ${moduleLabel(data.meta[k]?.parent)} will see it.`;
                  if (window.confirm(note)) run(`st:${k}`, 'set_module_status', { module_key: k, status: 'live' }, { users: true });
                }}
                style={BTN.secondary.sm}
              >
                Release
              </button>
            </div>
          );
        })}
        {dev.length === 0 && <div style={{ fontSize: 14, color: faint, padding: '6px 0' }}>Nothing is in development.</div>}
        <div style={{ display: 'flex', gap: 6, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${line}`, flexWrap: 'wrap' }}>
          <select value={back} onChange={(e) => setBack(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
            <option value="">Put a module back into development…</option>
            {live.map((k) => <option key={k} value={k}>{fullLabel(k)}</option>)}
          </select>
          <button
            disabled={!back || busy === `st:${back}`}
            onClick={() => {
              if (window.confirm(`Hide ${fullLabel(back)} from everyone except admins and testers?`)) {
                run(`st:${back}`, 'set_module_status', { module_key: back, status: 'in_development' }, { users: true });
                setBack('');
              }
            }}
            style={{ ...BTN.secondary.sm, opacity: back ? 1 : 0.5 }}
          >
            Move
          </button>
        </div>
      </Card>

      <Card title="New clients">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' }}>
          <div>
            <div style={{ fontSize: 14.5, color: ink, fontWeight: 500 }}>Figures on for everyone</div>
            <div style={{ fontSize: 12.5, color: faint, marginTop: 2 }}>
              {data.newClientDefault
                ? 'A new client is on for every staff member until you switch it off.'
                : 'A new client is off for everyone until you switch it on (admins always see it).'}
            </div>
          </div>
          <Switch
            on={data.newClientDefault}
            busy={busy === 'setting'}
            onChange={(v) => run('setting', 'set_setting', { key: 'new_client_figures_default', value: v })}
          />
        </div>
      </Card>

      <Card title="Email">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' }}>
          <div>
            <div style={{ fontSize: 14.5, color: ink, fontWeight: 500 }}>Most outside recipients per email</div>
            <div style={{ fontSize: 12.5, color: faint, marginTop: 2 }}>
              An email sent from Athena to more people outside the firm than this (To + Cc + Bcc) is refused.
              Mailings to clients go through Client Tax Reminders.
            </div>
          </div>
          <select
            value={data.emailCap}
            disabled={busy === 'emailCap'}
            onChange={(e) => run('emailCap', 'set_setting', { key: 'email_max_external_recipients', value: Number(e.target.value) })}
            style={{ padding: '5px 8px', fontSize: 14, fontFamily: font, border: `1px solid ${line}`, borderRadius: 7, background: '#fff', color: ink }}
          >
            {[...new Set([1, 2, 3, 5, 8, 10, 15, 20, data.emailCap])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </Card>
    </div>
  );
}

/* ─── Small pieces ───────────────────────────────────────────────────── */

function Card({ title, children }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${line}`, borderRadius: 12, padding: '12px 16px' }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: muted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

function Switch({ on, onChange, busy, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      {label && <span style={{ fontSize: 12.5, color: on ? tones.warning.fg : faint }}>{label}</span>}
      <button
        role="switch"
        aria-checked={on}
        disabled={busy}
        onClick={(e) => { e.preventDefault(); onChange(!on); }}
        style={{
          width: 34, height: 20, borderRadius: 10, border: 'none', padding: 0, position: 'relative',
          background: on ? brand.solid : '#cbd5e1', cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.5 : 1, transition: 'background 0.15s',
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%',
          background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        }} />
      </button>
    </span>
  );
}

function Tick({ on, label, onChange, busy }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, color: on ? '#334155' : faint, cursor: busy ? 'wait' : 'pointer' }}>
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: brand.solid }} />
      {label}
    </label>
  );
}

function Segmented({ value, onChange, options, small = false }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => o.value !== value && onChange(o.value)}
          style={{
            fontFamily: font, fontSize: small ? 12.5 : 14, fontWeight: o.value === value ? 600 : 500,
            padding: small ? '3px 9px' : '6px 14px', border: 'none', cursor: 'pointer',
            background: o.value === value ? brand.solid : '#fff',
            color: o.value === value ? brand.onSolid : '#334155',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Chip({ tone, children, title }) {
  const t = tones[tone] || tones.neutral;
  return (
    <span title={title} style={{ fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 999, background: t.bg, color: t.fg, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

function Notice({ tone, children }) {
  const t = tones[tone] || tones.neutral;
  return (
    <div style={{ background: t.bg, color: t.fg, borderRadius: 10, padding: '10px 14px', fontSize: 14, marginBottom: 12, fontFamily: font }}>
      {children}
    </div>
  );
}

const twoCol = (narrow) => (narrow
  ? { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }
  : { display: 'grid', gridTemplateColumns: '248px minmax(0, 1fr)', gap: 20, alignItems: 'start' });

const inputStyle = {
  width: '100%', border: `1px solid ${line}`, borderRadius: 8, padding: '8px 12px', fontSize: 14,
  fontFamily: font, outline: 'none', boxSizing: 'border-box',
};
const selectStyle = {
  border: `1px solid ${line}`, borderRadius: 8, padding: '7px 10px', fontSize: 13.5, fontFamily: font,
  background: '#fff', color: '#334155',
};
