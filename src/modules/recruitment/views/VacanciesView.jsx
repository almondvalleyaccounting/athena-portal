import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Briefcase, MapPin, Users, ChevronRight } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { listVacancies, createVacancy, listStaff, applicationCounts } from '../api';
import VacancyFormModal from '../components/VacancyFormModal';
import {
  font, card, btn, fmtSalary, fmtDate,
  EMPLOYMENT_TYPES, VACANCY_STATUS_MAP,
} from '../recruitmentShared';

const EMP_MAP = Object.fromEntries(EMPLOYMENT_TYPES.map((t) => [t.key, t.label]));

// Filter pills over vacancy status.
const FILTERS = [
  { key: 'active', label: 'Active' },   // open + on_hold
  { key: 'open', label: 'Open' },
  { key: 'draft', label: 'Draft' },
  { key: 'filled', label: 'Filled' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

export default function VacanciesView() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const canManage = profile?.can_manage_recruitment === true || profile?.is_portal_admin === true;
  const [vacancies, setVacancies] = useState(null);
  const [counts, setCounts] = useState({});
  const [staffList, setStaffList] = useState([]);
  const [staffMap, setStaffMap] = useState({});
  const [filter, setFilter] = useState('active');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [vs, st, cts] = await Promise.all([listVacancies(), listStaff(), applicationCounts()]);
      setVacancies(vs);
      setCounts(cts);
      setStaffList(st.filter((s) => s.is_active));
      setStaffMap(Object.fromEntries(st.map((s) => [s.id, s.name])));
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(patch) {
    const v = await createVacancy(patch, profile?.id);
    setVacancies((prev) => [v, ...(prev || [])]);
    setAdding(false);
    navigate(`/recruitment/${v.id}`);
  }

  const visible = useMemo(() => {
    const list = vacancies || [];
    if (filter === 'all') return list;
    if (filter === 'active') return list.filter((v) => v.status === 'open' || v.status === 'on_hold');
    return list.filter((v) => v.status === filter);
  }, [vacancies, filter]);

  const openCount = (vacancies || []).filter((v) => v.status === 'open').length;

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Briefcase size={20} color="#0e7fe0" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Vacancies</h1>
        <span style={{ fontSize: 13, color: '#64748b' }}>{openCount} open</span>
        {canManage && (
          <button onClick={() => setAdding(true)} style={{ ...btn('primary'), marginLeft: 'auto' }}>
            <Plus size={14} /> New vacancy
          </button>
        )}
      </div>
      <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 16px' }}>
        Roles the firm is hiring for. Open one to manage its applicant pipeline.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTERS.map((fl) => (
          <button key={fl.key} onClick={() => setFilter(fl.key)}
            style={{
              fontSize: 12, fontWeight: filter === fl.key ? 600 : 500, padding: '5px 12px', borderRadius: 999,
              cursor: 'pointer', fontFamily: font,
              background: filter === fl.key ? '#dbeafe' : '#fff',
              color: filter === fl.key ? '#0c4a6e' : '#64748b',
              border: `1px solid ${filter === fl.key ? '#93c5fd' : '#e5e7eb'}`,
            }}>{fl.label}</button>
        ))}
      </div>

      {error && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>{error}</div>}
      {vacancies === null && <div style={{ ...card, padding: 18, textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>Loading…</div>}

      {vacancies !== null && visible.length === 0 && (
        <div style={{ ...card, padding: '32px 18px', textAlign: 'center', fontSize: 13.5, color: '#94a3b8' }}>
          {filter === 'active' ? 'No active vacancies.' : 'Nothing here.'}
          {canManage && filter === 'active' && (
            <div style={{ marginTop: 10 }}>
              <button onClick={() => setAdding(true)} style={btn('primary')}><Plus size={14} /> Create your first vacancy</button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {visible.map((v) => {
          const st = VACANCY_STATUS_MAP[v.status] || VACANCY_STATUS_MAP.draft;
          const n = counts[v.id] || 0;
          return (
            <div key={v.id} onClick={() => navigate(`/recruitment/${v.id}`)}
              style={{ ...card, padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>{v.title}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: st.tone.bg, color: st.tone.fg, border: `1px solid ${st.tone.border}`,
                    textTransform: 'uppercase', letterSpacing: 0.3,
                  }}>{st.label}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 5, fontSize: 12, color: '#64748b', flexWrap: 'wrap' }}>
                  {v.department && <span>{v.department}</span>}
                  <span>{EMP_MAP[v.employment_type]}</span>
                  {v.location && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><MapPin size={11} /> {v.location}</span>}
                  {fmtSalary(v) && <span>{fmtSalary(v)}</span>}
                  {v.hiring_manager_id && staffMap[v.hiring_manager_id] && <span>· {staffMap[v.hiring_manager_id]}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: '#475569', whiteSpace: 'nowrap' }}>
                <Users size={13} color="#94a3b8" /> {n} in pipeline
              </div>
              <ChevronRight size={18} color="#cbd5e1" />
            </div>
          );
        })}
      </div>

      {adding && (
        <VacancyFormModal staffList={staffList} onClose={() => setAdding(false)} onSave={handleCreate} />
      )}
    </div>
  );
}
