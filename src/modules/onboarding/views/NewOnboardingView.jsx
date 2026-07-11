import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, MinusCircle, Zap } from 'lucide-react';
import { Btn } from '../../../components/ui';
import { tones, chipStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import {
  listTemplates, listStaff, searchEntities, activeOnboardingsForEntity,
  findCommittedQuote, hasLiveBilling, resolveSteps, createOnboarding,
} from '../api';

const font = "'Outfit', sans-serif";
const label = { display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 };
const input = {
  padding: '8px 12px', fontSize: 13, fontFamily: font, background: '#fff',
  border: '1px solid #cbd5e1', borderRadius: 8, width: '100%', boxSizing: 'border-box',
};
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };

export default function NewOnboardingView() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [params] = useSearchParams();

  const [templates, setTemplates] = useState([]);
  const [staff, setStaff] = useState([]);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState('');
  const [entities, setEntities] = useState([]);
  const [entity, setEntity] = useState(null);
  const [existing, setExisting] = useState([]);
  const [templateId, setTemplateId] = useState(null);
  const [ownerId, setOwnerId] = useState('');
  const [leadId, setLeadId] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [preview, setPreview] = useState(null); // { quote, resolved }
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([listTemplates(), listStaff()])
      .then(([t, s]) => {
        setTemplates(t);
        setStaff(s);
        // Default owner: Sophie runs onboarding; fall back to current user
        const sophie = s.find((x) => x.name === 'Sophie Laidlaw');
        setOwnerId(sophie?.id || profile?.id || '');
      })
      .catch((e) => setError(e.message));
  }, [profile?.id]);

  // Entity search (debounced)
  useEffect(() => {
    const h = setTimeout(() => {
      searchEntities(search).then(setEntities).catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(h);
  }, [search]);

  // Pre-select entity when arriving via /onboarding/new?entity=<id>
  useEffect(() => {
    const preselect = params.get('entity');
    if (!preselect || entity) return;
    searchEntities('').then(async () => {
      const { supabase } = await import('../../../lib/supabase');
      const { data } = await supabase.from('entities').select('id, name, entity_status').eq('id', preselect).single();
      if (data) setEntity(data);
    });
  }, [params, entity]);

  const template = useMemo(() => templates.find((t) => t.id === templateId) || null, [templates, templateId]);

  // Resolve conditional / auto-check steps whenever entity + template are set
  useEffect(() => {
    if (!entity || !template) { setPreview(null); return; }
    let cancelled = false;
    Promise.all([findCommittedQuote(entity.id), hasLiveBilling(entity.id), activeOnboardingsForEntity(entity.id)])
      .then(([{ quote, serviceIds }, liveBilling, open]) => {
        if (cancelled) return;
        setExisting(open);
        setPreview({ quote, resolved: resolveSteps(template.steps, { quote, serviceIds, liveBilling }) });
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [entity, template]);

  async function handleCreate() {
    if (!entity || !template) return;
    setSaving(true);
    setError(null);
    try {
      const id = await createOnboarding({
        entityId: entity.id, template,
        ownerId: ownerId || null, leadId: leadId || null,
        targetDate: targetDate || null, actorId: profile?.id || null,
      });
      navigate(`/onboarding/${id}`);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  const groups = useMemo(() => {
    if (!preview) return [];
    const byGroup = new Map();
    preview.resolved.forEach((r) => {
      const key = r.templateStep.group_name;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(r);
    });
    return [...byGroup.entries()];
  }, [preview]);

  return (
    <div style={{ padding: '24px 28px', fontFamily: font, maxWidth: 1000 }}>
      <button
        onClick={() => navigate('/onboarding')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: '#64748b', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 14, fontFamily: font }}
      >
        <ArrowLeft size={14} /> Back to pipeline
      </button>
      <h1 style={{ margin: '0 0 18px', fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Start an onboarding</h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* Left column: choices */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={card}>
            <span style={label}>Client</span>
            {entity ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 14.5, fontWeight: 600, color: '#0f172a' }}>{entity.name}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>{entity.entity_status}</div>
                </div>
                <button onClick={() => { setEntity(null); setPreview(null); setExisting([]); }} style={{ background: 'none', border: 'none', color: '#0e7fe0', fontSize: 12, cursor: 'pointer', fontFamily: font }}>
                  change
                </button>
              </div>
            ) : (
              <>
                <input style={input} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…" autoFocus />
                <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 8 }}>
                  {entities.map((e) => (
                    <div
                      key={e.id}
                      onClick={() => setEntity(e)}
                      style={{ padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13.5, color: '#0f172a', display: 'flex', justifyContent: 'space-between' }}
                      onMouseEnter={(ev) => (ev.currentTarget.style.background = '#f1f5f9')}
                      onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}
                    >
                      <span>{e.name}</span>
                      <span style={{ fontSize: 11, color: '#94a3b8' }}>{e.entity_status}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {existing.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: tones.warning.fg, background: tones.warning.bg, borderRadius: 8, padding: '8px 10px' }}>
                This client already has {existing.length} open onboarding{existing.length > 1 ? 's' : ''} — check the pipeline before starting another.
              </div>
            )}
          </div>

          <div style={card}>
            <span style={label}>Workflow template</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {templates.map((t) => (
                <div
                  key={t.id}
                  onClick={() => setTemplateId(t.id)}
                  style={{
                    padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                    border: templateId === t.id ? '2px solid #F5C518' : '1px solid #e5e7eb',
                    background: templateId === t.id ? '#fffbeb' : '#fff',
                  }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>{t.name}</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{t.steps.length} steps</div>
                </div>
              ))}
            </div>
          </div>

          <div style={card}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={label}>Owner (drives it)</span>
                <select style={input} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  <option value="">—</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <span style={label}>Lead (brought them in)</span>
                <select style={input} value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                  <option value="">—</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={label}>Target date (optional)</span>
                <input type="date" style={input} value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
              </div>
            </div>
          </div>

          {error && <div style={{ color: tones.danger.fg, fontSize: 13 }}>{error}</div>}
          <Btn onClick={handleCreate} disabled={!entity || !template || saving}>
            {saving ? 'Starting…' : 'Start onboarding'}
          </Btn>
        </div>

        {/* Right column: resolved preview */}
        <div style={{ ...card, position: 'sticky', top: 16 }}>
          <span style={label}>What will be created</span>
          {!preview && <div style={{ fontSize: 13, color: '#94a3b8' }}>Pick a client and a template to preview the checklist.</div>}
          {preview && (
            <>
              <div style={{ fontSize: 12.5, marginBottom: 12, color: preview.quote ? tones.success.fg : tones.warning.fg }}>
                {preview.quote
                  ? `Linked to ${preview.quote.status} quote ${preview.quote.quote_ref || ''} — conditional steps resolved from its services.`
                  : 'No committed/accepted quote found — all steps start as To do; mark N/A manually as needed.'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 480, overflowY: 'auto' }}>
                {groups.map(([groupName, items]) => (
                  <div key={groupName}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                      {groupName}
                    </div>
                    {items.map((r) => (
                      <div key={r.templateStep.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 13, color: r.initialStatus === 'na' ? '#94a3b8' : '#0f172a' }}>
                        {r.initialStatus === 'complete' && <CheckCircle2 size={14} color={tones.success.solid} />}
                        {r.initialStatus === 'na' && <MinusCircle size={14} color="#cbd5e1" />}
                        {r.initialStatus === 'pending' && <span style={{ width: 14, height: 14, borderRadius: 999, border: '1.5px solid #cbd5e1', display: 'inline-block', flexShrink: 0 }} />}
                        <span style={{ textDecoration: r.initialStatus === 'na' ? 'line-through' : 'none', flex: 1 }}>{r.templateStep.name}</span>
                        {r.templateStep.owner_type === 'client' && <span style={chipStyle('warning')}>client</span>}
                        {r.templateStep.owner_type === 'system' && (
                          <span style={{ ...chipStyle('info'), display: 'inline-flex', alignItems: 'center', gap: 3 }}><Zap size={9} /> auto</span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
