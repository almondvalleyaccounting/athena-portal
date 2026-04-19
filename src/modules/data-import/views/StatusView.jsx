import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clipboard, BarChart2, Link as LinkIcon, ArrowRight, X } from 'lucide-react';
import { SOURCES, SYSTEMS, getSystemLabel } from '../lib/sources';
import { fetchStatusCounts, fetchLatestPerSource, fetchStaffNames, fetchImportAccessStaff } from '../lib/importQueries';

const font = "'Outfit', sans-serif";
const ICONS = { bm: Clipboard, tc: BarChart2, qbo: LinkIcon };

function formatDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yy} at ${hh}:${mi}`;
}

export default function StatusView() {
  const navigate = useNavigate();
  const [counts, setCounts] = useState({ total: 0, active: 0, prospects: 0, lastImport: null });
  const [latest, setLatest] = useState({});
  const [staffNames, setStaffNames] = useState({});
  const [accessStaff, setAccessStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalSource, setModalSource] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [c, l, a] = await Promise.all([
          fetchStatusCounts(),
          fetchLatestPerSource(),
          fetchImportAccessStaff(),
        ]);
        setCounts(c);
        setLatest(l);
        setAccessStaff(a);
        const triggerIds = Object.values(l).map((r) => r.triggered_by);
        if (triggerIds.length) {
          const names = await fetchStaffNames(triggerIds);
          setStaffNames(names);
        }
      } catch (e) {
        console.error('[DataImport] status load error:', e);
      }
      setLoading(false);
    })();
  }, []);

  const lastImportStr = counts.lastImport ? formatDateTime(counts.lastImport) : '—';

  return (
    <div style={{ padding: '24px 28px', fontFamily: font, maxWidth: 1180 }}>
      {/* Summary bar */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12,
        overflow: 'hidden', marginBottom: 32,
      }}>
        <StatCell label="Total entities" value={loading ? '—' : counts.total} />
        <StatCell label="Active clients" value={loading ? '—' : counts.active} />
        <StatCell label="Prospects" value={loading ? '—' : counts.prospects} />
        <StatCell label="Last import" value={loading ? '—' : lastImportStr} small />
      </div>

      {/* Source cards */}
      {SYSTEMS.map((sys) => {
        const sysSources = SOURCES.filter((s) => s.system === sys.id);
        const cols = sys.id === 'tc' ? 4 : 2;
        return (
          <div key={sys.id} style={{ marginBottom: 28 }}>
            <p style={{
              fontSize: 11, fontWeight: 700, color: '#94a3b8',
              textTransform: 'uppercase', letterSpacing: '0.08em',
              marginBottom: 10,
            }}>{sys.label}</p>
            <div style={{
              display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12,
            }}>
              {sysSources.map((src) => (
                <SourceCard
                  key={src.key}
                  source={src}
                  latest={latest[src.key]}
                  triggeredByName={staffNames[latest[src.key]?.triggered_by]}
                  onPull={() => setModalSource(src)}
                  onImport={() => navigate(`/admin/import/run?source=${src.key}`)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Access footer (Settings tab folded in) */}
      <div style={{
        marginTop: 28, padding: '16px 20px',
        background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10,
      }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          Data Import access
        </p>
        {accessStaff.length === 0 ? (
          <p style={{ fontSize: 13, color: '#64748b' }}>No staff have access yet. Grant <code>can_import_data</code> via Admin → Staff & Permissions.</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {accessStaff.map((s) => (
              <span key={s.id} style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 999,
                background: '#fff', border: '1px solid #e5e7eb', color: '#1e293b',
              }}>
                {s.name}{s.is_portal_admin ? ' · admin' : ''}
              </span>
            ))}
          </div>
        )}
        <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>
          To grant or revoke access, go to <a onClick={() => navigate('/admin/staff')} style={{ color: '#0e7fe0', cursor: 'pointer' }}>Staff & Permissions</a>.
        </p>
      </div>

      {modalSource && (
        <PullModal source={modalSource} onClose={() => setModalSource(null)} onGoToImport={() => {
          setModalSource(null);
          navigate(`/admin/import/run?source=${modalSource.key}`);
        }} />
      )}
    </div>
  );
}

function StatCell({ label, value, small }) {
  return (
    <div style={{ padding: '16px 20px', borderRight: '1px solid #e5e7eb' }}>
      <p style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: small ? 14 : 22, fontWeight: 600, color: '#0f172a' }}>{value}</p>
    </div>
  );
}

function SourceCard({ source, latest, triggeredByName, onPull, onImport }) {
  const Icon = ICONS[source.system] || Clipboard;
  const neverImported = !latest;
  const coming = source.comingSoon;

  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderLeft: neverImported && !coming ? '3px solid #f59e0b' : '1px solid #e5e7eb',
      borderRadius: 10, padding: 16,
      opacity: coming ? 0.55 : 1,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon size={14} style={{ color: '#64748b' }} />
        <p style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
          {getSystemLabel(source.system)} — {source.name}
        </p>
      </div>

      {coming ? (
        <p style={{ fontSize: 12, color: '#94a3b8' }}>Coming soon</p>
      ) : neverImported ? (
        <p style={{ fontSize: 12, color: '#94a3b8' }}>Never imported</p>
      ) : (
        <>
          <div>
            <p style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Last imported</p>
            <p style={{ fontSize: 13, color: '#1e293b' }}>{formatDateTime(latest.triggered_at)}</p>
            {triggeredByName && <p style={{ fontSize: 11, color: '#94a3b8' }}>by {triggeredByName}</p>}
          </div>
          {latest.row_counts && Object.keys(latest.row_counts).length > 0 && (
            <div>
              {Object.entries(latest.row_counts).map(([table, n]) => (
                <p key={table} style={{ fontSize: 12, color: '#475569' }}>
                  {Number(n).toLocaleString()} {table}
                </p>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 4, paddingTop: 10, display: 'flex', gap: 8 }}>
        {coming ? (
          <span style={{
            fontSize: 11, padding: '4px 10px', borderRadius: 999,
            background: '#f1f5f9', color: '#94a3b8',
          }}>Coming soon</span>
        ) : (
          <>
            <button onClick={onPull} style={btnSecondary}>Pull export</button>
            <button onClick={onImport} style={btnPrimary}>
              Go to Import <ArrowRight size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function PullModal({ source, onClose, onGoToImport }) {
  useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 12, width: 560, maxWidth: '90vw',
        padding: 24, fontFamily: font,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>
            Export instructions — {getSystemLabel(source.system)} {source.name}
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
          Automated export is not yet configured for this source. Follow these steps:
        </p>
        <ol style={{ fontSize: 13, color: '#1e293b', paddingLeft: 20, marginBottom: 16 }}>
          {source.pullSteps.map((step, i) => (
            <li key={i} style={{ marginBottom: 6 }}>{step}</li>
          ))}
        </ol>
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
          Once you have the file, upload it in the Import tab.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid #f1f5f9', paddingTop: 14 }}>
          <button onClick={onClose} style={btnSecondary}>Close</button>
          <button onClick={onGoToImport} style={btnPrimary}>
            Go to Import <ArrowRight size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

const btnSecondary = {
  fontSize: 12, fontWeight: 500, padding: '6px 12px',
  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
  color: '#1e293b', cursor: 'pointer', fontFamily: font,
};
const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 12, fontWeight: 600, padding: '6px 12px',
  background: '#0f172a', border: 'none', borderRadius: 8,
  color: '#fff', cursor: 'pointer', fontFamily: font,
};
