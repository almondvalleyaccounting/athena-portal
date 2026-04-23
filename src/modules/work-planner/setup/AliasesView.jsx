import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { listAliases, updateAlias, listStaffProfiles } from './queries';

const font = "'Outfit', sans-serif";

export default function AliasesView() {
  const [aliases, setAliases] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingName, setSavingName] = useState(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, s] = await Promise.all([listAliases(), listStaffProfiles()]);
      setAliases(a);
      setStaff(s);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const update = async (name, patch) => {
    setSavingName(name);
    setError(null);
    try {
      await updateAlias(name, patch);
      setAliases((prev) => prev.map((a) =>
        a.bm_assignee_name === name ? { ...a, ...patch } : a
      ));
    } catch (e) {
      setError(e.message || String(e));
      await reload();
    } finally {
      setSavingName(null);
    }
  };

  const unmappedCount = aliases.filter((a) => !a.staff_profile_id && a.active).length;
  const mappedCount = aliases.filter((a) => a.staff_profile_id).length;

  return (
    <div style={{ padding: '20px 28px', fontFamily: font }}>
      <p style={{ fontSize: 13, color: '#475569', maxWidth: 760, marginBottom: 14 }}>
        Every BM assignee name seen in a tasks import lands here. Map each to a real staff profile so tasks get the right <code>assignee_id</code>, or mark inactive if the person has left. New aliases appear automatically — no manual creation needed.
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <span style={pill('green')}>{mappedCount} mapped</span>
        {unmappedCount > 0 && <span style={pill('amber')}>{unmappedCount} unmapped</span>}
      </div>

      {error && (
        <div style={banner('red')}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</p>
      ) : aliases.length === 0 ? (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          No aliases yet. They'll appear the first time a BM Tasks import runs.
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={th}>BM name</th>
                <th style={th}>Mapped to Athena staff</th>
                <th style={th}>First seen</th>
                <th style={th}>Last seen</th>
                <th style={th}>Status</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {aliases.map((a) => {
                const saving = savingName === a.bm_assignee_name;
                const mapped = !!a.staff_profile_id;
                return (
                  <tr key={a.bm_assignee_name} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      <b>{a.display_name || a.bm_assignee_name}</b>
                      <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>{a.bm_assignee_name}</div>
                    </td>
                    <td style={td}>
                      <select
                        value={a.staff_profile_id || ''}
                        onChange={(e) => update(a.bm_assignee_name, { staff_profile_id: e.target.value || null })}
                        disabled={saving}
                        style={{ ...inp, minWidth: 220 }}
                      >
                        <option value="">— unmapped —</option>
                        {staff.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}{s.is_active ? '' : ' (inactive)'}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ ...td, color: '#64748b' }}>{fmtDate(a.first_seen_at)}</td>
                    <td style={{ ...td, color: '#64748b' }}>{fmtDate(a.last_seen_at)}</td>
                    <td style={td}>
                      {mapped ? (
                        <span style={pill('green')}>Mapped</span>
                      ) : a.active ? (
                        <span style={pill('amber')}>Unmapped</span>
                      ) : (
                        <span style={pill('slate')}>Former</span>
                      )}
                    </td>
                    <td style={td}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#475569', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={!!a.active}
                          disabled={saving}
                          onChange={(e) => update(a.bm_assignee_name, { active: e.target.checked })}
                        />
                        Active
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

const th = { textAlign: 'left', padding: '10px 12px', fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' };
const td = { padding: '10px 12px', fontSize: 12, verticalAlign: 'middle', color: '#1e293b' };
const inp = { padding: '4px 6px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 12, fontFamily: font, background: '#fff' };

function pill(tone) {
  const tones = {
    green: { bg: '#dcfce7', color: '#15803d' },
    amber: { bg: '#fef3c7', color: '#92400e' },
    slate: { bg: '#f1f5f9', color: '#475569' },
  };
  const t = tones[tone] || tones.slate;
  return { fontSize: 11, padding: '2px 8px', borderRadius: 999, background: t.bg, color: t.color, fontWeight: 500 };
}
function banner(tone) {
  const tones = { red: { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b' } };
  const t = tones[tone] || tones.red;
  return { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 8, background: t.bg, border: `1px solid ${t.border}`, color: t.color, fontSize: 13, marginBottom: 14 };
}
