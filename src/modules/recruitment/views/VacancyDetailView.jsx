import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Plus, MapPin, Pencil, ExternalLink, Trash2, Link2,
} from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import {
  getVacancy, updateVacancy, listApplications, addApplication, updateApplication,
  listStaff, listAdverts, createAdvert, deleteAdvert,
} from '../api';
import PipelineBoard from '../components/PipelineBoard';
import ApplicationDrawer from '../components/ApplicationDrawer';
import AddApplicationModal from '../components/AddApplicationModal';
import VacancyFormModal from '../components/VacancyFormModal';
import {
  font, card, btn, fmtSalary, fmtDate,
  EMPLOYMENT_TYPES, WORK_MODES, VACANCY_STATUS_MAP, ADVERT_CHANNELS,
} from '../recruitmentShared';

const EMP_MAP = Object.fromEntries(EMPLOYMENT_TYPES.map((t) => [t.key, t.label]));
const MODE_MAP = Object.fromEntries(WORK_MODES.map((t) => [t.key, t.label]));
const CHANNEL_MAP = Object.fromEntries(ADVERT_CHANNELS.map((c) => [c.key, c.label]));

const TABS = [
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'details', label: 'Details' },
  { key: 'adverts', label: 'Adverts' },
];

export default function VacancyDetailView() {
  const { vacancyId } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const canManage = profile?.can_manage_recruitment === true || profile?.is_portal_admin === true;

  const [vacancy, setVacancy] = useState(null);
  const [apps, setApps] = useState([]);
  const [adverts, setAdverts] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [staffMap, setStaffMap] = useState({});
  const [tab, setTab] = useState('pipeline');
  const [openAppId, setOpenAppId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [v, a, st, ad] = await Promise.all([
        getVacancy(vacancyId), listApplications(vacancyId), listStaff(), listAdverts(vacancyId),
      ]);
      setVacancy(v);
      setApps(a);
      setAdverts(ad);
      setStaffList(st.filter((s) => s.is_active));
      setStaffMap(Object.fromEntries(st.map((s) => [s.id, s.name])));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [vacancyId]);

  useEffect(() => { load(); }, [load]);

  async function handleAddApplicant(payload) {
    const app = await addApplication({ ...payload, vacancyId, createdBy: profile?.id });
    setApps((prev) => [app, ...prev]);
    setAdding(false);
    setOpenAppId(app.id);
  }

  async function patchApp(id, patch) {
    // optimistic
    setApps((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    try {
      const updated = await updateApplication(id, patch);
      setApps((prev) => prev.map((a) => (a.id === id ? updated : a)));
    } catch (e) { setError(e.message); load(); }
  }

  async function handleMove(app, newStage) {
    patchApp(app.id, { stage: newStage });
  }

  async function saveVacancy(patch) {
    const v = await updateVacancy(vacancyId, patch);
    setVacancy(v);
    setEditing(false);
  }

  const openApp = apps.find((a) => a.id === openAppId) || null;

  if (loading) return <div style={{ fontFamily: font, color: '#94a3b8', fontSize: 13, padding: 20 }}>Loading…</div>;
  if (!vacancy) return <div style={{ fontFamily: font, color: '#b91c1c', fontSize: 13, padding: 20 }}>{error || 'Vacancy not found.'}</div>;

  const st = VACANCY_STATUS_MAP[vacancy.status] || VACANCY_STATUS_MAP.draft;

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', fontFamily: font }}>
      <button onClick={() => navigate('/recruitment')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', color: '#64748b', fontSize: 12.5, cursor: 'pointer', fontFamily: font, padding: 0, marginBottom: 12 }}>
        <ArrowLeft size={14} /> All vacancies
      </button>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>{vacancy.title}</h1>
            <span style={{
              fontSize: 10.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999,
              background: st.tone.bg, color: st.tone.fg, border: `1px solid ${st.tone.border}`,
              textTransform: 'uppercase', letterSpacing: 0.3,
            }}>{st.label}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6, fontSize: 12.5, color: '#64748b', flexWrap: 'wrap' }}>
            {vacancy.department && <span>{vacancy.department}</span>}
            <span>{EMP_MAP[vacancy.employment_type]} · {MODE_MAP[vacancy.work_mode]}</span>
            {vacancy.location && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><MapPin size={12} /> {vacancy.location}</span>}
            {fmtSalary(vacancy) && <span>{fmtSalary(vacancy)}</span>}
            {vacancy.hiring_manager_id && staffMap[vacancy.hiring_manager_id] && <span>· {staffMap[vacancy.hiring_manager_id]}</span>}
          </div>
        </div>
        {canManage && (
          <button onClick={() => setEditing(true)} style={btn('secondary')}><Pencil size={13} /> Edit</button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #e5e7eb', margin: '14px 0 18px' }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: '8px 4px', marginBottom: -1, background: 'none', border: 'none', cursor: 'pointer', fontFamily: font,
              fontSize: 13, fontWeight: tab === t.key ? 700 : 500,
              color: tab === t.key ? '#0f172a' : '#94a3b8',
              borderBottom: `2px solid ${tab === t.key ? '#0e7fe0' : 'transparent'}`,
            }}>{t.label}</button>
        ))}
        {tab === 'pipeline' && (
          <button onClick={() => setAdding(true)} style={{ ...btn('primary'), marginLeft: 'auto' }}>
            <Plus size={14} /> Add applicant
          </button>
        )}
      </div>

      {error && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>{error}</div>}

      {tab === 'pipeline' && (
        apps.length === 0 ? (
          <div style={{ ...card, padding: '32px 18px', textAlign: 'center', fontSize: 13.5, color: '#94a3b8' }}>
            No applicants yet. Add one manually, or they'll arrive via the jobs@ inbox once wired up.
            <div style={{ marginTop: 10 }}>
              <button onClick={() => setAdding(true)} style={btn('primary')}><Plus size={14} /> Add applicant</button>
            </div>
          </div>
        ) : (
          <PipelineBoard applications={apps} staffMap={staffMap} onOpen={(a) => setOpenAppId(a.id)} onMove={handleMove} />
        )
      )}

      {tab === 'details' && <DetailsPanel vacancy={vacancy} />}

      {tab === 'adverts' && (
        <AdvertsPanel
          adverts={adverts} canManage={canManage}
          onCreate={async (patch) => { const a = await createAdvert({ ...patch, vacancy_id: vacancyId }); setAdverts((p) => [a, ...p]); }}
          onDelete={async (id) => { await deleteAdvert(id); setAdverts((p) => p.filter((x) => x.id !== id)); }}
        />
      )}

      {openApp && (
        <ApplicationDrawer
          app={openApp} staffMap={staffMap} staffList={staffList} profileId={profile?.id}
          onClose={() => setOpenAppId(null)}
          onPatch={(patch) => patchApp(openApp.id, patch)}
        />
      )}
      {adding && (
        <AddApplicationModal vacancyTitle={vacancy.title} onClose={() => setAdding(false)} onAdd={handleAddApplicant} />
      )}
      {editing && (
        <VacancyFormModal initial={vacancy} staffList={staffList} onClose={() => setEditing(false)} onSave={saveVacancy} />
      )}
    </div>
  );
}

function DetailsPanel({ vacancy }) {
  const Field = ({ label, children }) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13.5, color: '#334155', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{children || <span style={{ color: '#cbd5e1' }}>—</span>}</div>
    </div>
  );
  return (
    <div style={{ ...card, padding: '18px 20px', maxWidth: 760 }}>
      <Field label="Description">{vacancy.description}</Field>
      <Field label="Requirements">{vacancy.requirements}</Field>
      <div style={{ fontSize: 11.5, color: '#94a3b8', borderTop: '1px solid #f1f5f9', paddingTop: 10 }}>
        Created {fmtDate(vacancy.created_at)}
      </div>
    </div>
  );
}

function AdvertsPanel({ adverts, canManage, onCreate, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [channel, setChannel] = useState('own');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');

  async function submit() {
    if (adding === 'saving') return;
    setAdding('saving');
    try {
      await onCreate({ channel, external_url: url.trim() || null, external_ref: ref.trim() || null, status: 'live', posted_at: new Date().toISOString().slice(0, 10) });
      setChannel('own'); setUrl(''); setRef(''); setAdding(false);
    } catch { setAdding(true); }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ fontSize: 12.5, color: '#64748b', margin: '0 0 14px' }}>
        Where this role is posted. Athena doesn't push to boards yet — post on each site, then record the public link here so applications can be traced back.
      </p>
      {adverts.length === 0 && !adding && (
        <div style={{ ...card, padding: '22px 18px', textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>No adverts recorded.</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {adverts.map((a) => (
          <div key={a.id} style={{ ...card, padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', minWidth: 130 }}>{CHANNEL_MAP[a.channel] || a.channel}</span>
            {a.external_url
              ? <a href={a.external_url} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: '#0e7fe0', display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Link2 size={12} /> {a.external_url} <ExternalLink size={11} /></a>
              : <span style={{ flex: 1, fontSize: 12.5, color: '#cbd5e1' }}>No link</span>}
            {a.posted_at && <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{fmtDate(a.posted_at)}</span>}
            {canManage && (
              <button onClick={() => onDelete(a.id)} title="Remove" style={{ background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer', display: 'flex' }}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      {canManage && (adding ? (
        <div style={{ ...card, padding: '14px 16px', marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 4 }}>Channel</div>
              <select value={channel} onChange={(e) => setChannel(e.target.value)} style={{ padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8 }}>
                {ADVERT_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 4 }}>Public link</div>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" style={{ width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box' }} />
            </div>
            <button onClick={submit} style={btn('primary')}>Save</button>
            <button onClick={() => setAdding(false)} style={btn('ghost')}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ ...btn('secondary'), marginTop: 10 }}><Plus size={13} /> Record an advert</button>
      ))}
    </div>
  );
}
