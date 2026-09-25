import React, { useEffect, useMemo, useState } from 'react';
import { X, ArrowRight, ArrowLeft, Download, FileText, Mail, Plus, RotateCcw, Trash2, ExternalLink, Sparkles } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbpDetailed } from '../../lib/money';
import { BTN } from '../../lib/buttonStyles';
import {
  BUCKETS, REASONS, REASON_BY_KEY, OUR_FEES_FOOTNOTE, VAT_RATE, visibleBuckets,
  bucketFor, suggestReason, reasonFromSaved, reasonText, summarise, firstOfNextMonth, longDate,
  kindOf, lineNeedsAcceptance, savedChanges, componentsOf, BUCKET_BY_KEY,
} from './repriceReasons';
import { buildRepricePdf, pdfBase64, pdfFilename, serviceName } from './repricePdf';
import { composeRepriceEmail, defaultCoveringText } from './composeRepriceEmail';
import { resolvePrimaryContact, firstNameOf, candidateAddresses } from './recipients';
import { buildServiceResolver, standardFor, EMPTY_DRIVERS, DRIVER_LABEL, BUILDERS, builderDefaults, priceBuild } from './standardPricing';
import { fetchFeeDefaults } from '../../contexts/FeeEngineContext';
import { fetchFeeEngineServices } from './billingServices';
import ServicePicker from './ServicePicker';

const font = "'Outfit', sans-serif";
const serif = "'Playfair Display', serif";

// Reprice one client, then write to them about it.
//
// Step 1 — Reprice: every approved service the client takes, old beside
// new. Each changed line carries a reason, suggested from the amounts
// and service and changeable (or "Other" + free text). Saving stages
// the new amounts exactly as the matrix does (pending_monthly_amount on
// the service line, row → staged), so it still goes through Push
// uplifts for approval before anything reaches QBO.
//
// Step 2 — Write to the client: an editable covering note above the
// summary table, the letter as a PDF with the waterfall, and a Gmail
// draft with the PDF attached. Nothing is sent from here — the draft
// is finished and sent in Gmail, as on Push uplifts.
export default function RepriceClientModal({ entity, rows, profile, onSaveRow, onClose, onOpenClient }) {
  const clientRows = useMemo(() => rows.filter((r) => r.entity_id === entity.id), [rows, entity.id]);

  const [step, setStep] = useState('price'); // price | email
  const [lines, setLines] = useState(() => initialLines(clientRows));
  const [effectiveAt, setEffectiveAt] = useState(() => initialEffective(clientRows));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);

  // Standard pricing: the fee engine's defaults, the QBO item → service
  // map, and this client's drivers (prefilled where Athena knows them).
  const [feeDefaults, setFeeDefaults] = useState(null);
  const [resolveService, setResolveService] = useState(() => () => null);
  const [drivers, setDrivers] = useState(EMPTY_DRIVERS);
  const [driverSources, setDriverSources] = useState({});
  const [seedNote, setSeedNote] = useState(null);
  const [feServices, setFeServices] = useState([]);

  useEffect(() => { fetchFeeEngineServices().then(setFeServices).catch(() => setFeServices([])); }, []);

  // Who the letter and email are for — loaded once, used by the letter
  // preview on either step and by the email step's To list.
  const [recipient, setRecipient] = useState(null); // { contact, contactName, candidates }
  const [letterPreview, setLetterPreview] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase
        .from('entities')
        .select('id, name, billing_email, entity_people(is_primary_contact, person:people(id, name, first_name, preferred_name, email)), qbo_customer_mappings(qbo_email, role)')
        .eq('id', entity.id)
        .maybeSingle();
      if (!live) return;
      const contact = resolvePrimaryContact(data);
      setRecipient({ contact, contactName: firstNameOf(contact), candidates: candidateAddresses(data, contact) });
    })();
    return () => { live = false; };
  }, [entity.id]);

  useEffect(() => {
    let live = true;
    (async () => {
      const [D, { data: maps }, { data: people }, { data: quotes }, { data: ent }] = await Promise.all([
        fetchFeeDefaults(),
        supabase.from('qbo_service_items').select('service_id, qbo_item_name').eq('is_adhoc', false),
        supabase.from('entity_people').select('role').eq('entity_id', entity.id).eq('role', 'director').is('ended_on', null),
        supabase.from('quotes').select('estimated_turnover, accounts_detail, payroll_detail, directors, created_at')
          .eq('entity_id', entity.id).order('created_at', { ascending: false }).limit(1),
        supabase.from('entities').select('type, company_status_detail').eq('id', entity.id).maybeSingle(),
      ]);
      if (!live) return;
      setFeeDefaults(D);
      setResolveService(() => buildServiceResolver(maps));
      const q = quotes?.[0];
      const next = { ...EMPTY_DRIVERS };
      const src = {};
      if (q?.estimated_turnover) { next.turnover = String(q.estimated_turnover); src.turnover = 'last quote'; }
      if (q?.accounts_detail?.type) {
        next.accountsType = q.accounts_detail.type;
        if (q.accounts_detail.properties) next.properties = q.accounts_detail.properties;
        src.accountsType = 'last quote';
      } else if (/dormant/i.test(ent?.company_status_detail || '')) {
        next.accountsType = 'dormant'; src.accountsType = 'Companies House';
      }
      const dirCount = (people || []).length;
      if (dirCount) { next.directors = String(dirCount); src.directors = 'Companies House officers'; }
      else if (Array.isArray(q?.directors) && q.directors.length) { next.directors = String(q.directors.length); src.directors = 'last quote'; }
      if (q?.payroll_detail) {
        next.monthlyEmployees = String(q.payroll_detail.monthly_ee ?? '');
        next.weeklyEmployees = String(q.payroll_detail.weekly_ee ?? '');
        src.employees = 'last quote';
      }
      setDrivers(next);
      setDriverSources(src);
    })();
    return () => { live = false; };
  }, [entity.id]);

  // Standard monthly price per line, keyed by line key.
  const standards = useMemo(() => {
    const out = {};
    if (!feeDefaults) return out;
    for (const l of lines) {
      const sid = l.feeEngineServiceId || resolveService(l.serviceId, l.description);
      out[l.key] = sid ? standardFor(sid, drivers, feeDefaults) : null;
    }
    return out;
  }, [lines, drivers, feeDefaults, resolveService]);

  // Which drivers matter for this client's services.
  const relevant = useMemo(() => {
    const need = new Set();
    for (const l of lines) {
      const sid = l.feeEngineServiceId || resolveService(l.serviceId, l.description);
      if (sid === 'accounts_ct' || sid === 'ltd_accounts' || sid === 'property_accounts') need.add('accounts');
      if (sid === 'directors_tax_return') need.add('directors');
      if (sid === 'payroll') need.add('employees');
    }
    return need;
  }, [lines, resolveService]);

  // Seed New from standard wherever standard is higher than today's fee.
  // A line already at or above standard keeps its fee: seeding brings
  // fees up to the price book, it never cuts them. Clicking the standard
  // figure on a line applies it regardless.
  const seedFromStandard = () => {
    let raised = 0, kept = 0;
    const missing = new Set();
    const next = lines.map((l) => {
      const st = standards[l.key];
      if (!st) return l;
      if (st.missing) { missing.add(st.missing); return l; }
      if (st.monthly <= l.current) { kept += 1; return l; }
      raised += 1;
      const out = { ...l, next: String(st.monthly) };
      if (!out.reasonTouched) out.reasonKey = suggestReason({ serviceId: l.serviceId, current: l.current, next: st.monthly });
      return out;
    });
    setLines(next);
    const parts = [`${raised} fee${raised === 1 ? '' : 's'} raised to standard`];
    if (kept) parts.push(`${kept} already at or above standard, kept`);
    if (missing.size) parts.push(`set the ${[...missing].map((m) => DRIVER_LABEL[m]).join(' and ')} to price the rest`);
    setSeedNote(parts.join(' · '));
  };

  const summary = useMemo(() => summarise(lines.map(asNumbers)), [lines]);
  // The lines the letter and email describe: a new service still at £0
  // hasn't been priced, so it isn't on them.
  const letterLines = useMemo(() => lines.map(asNumbers).filter((l) => !(l.isNew && !(l.next > 0))), [lines]);

  // Notice or proposal follows from the changes (repriceReasons: only a
  // new service needs the client's agreement).
  const kind = kindOf(summary);
  const dirty = useMemo(() => lines.some((l) => lineDirty(l)) || effectiveAt !== initialEffective(clientRows), [lines, effectiveAt, clientRows]);
  const missingReason = lines.some((l) => isChanged(l) && ((l.reasonKey === 'other' && !l.otherText.trim()) || (l.extra || []).some((e) => e.reasonKey === 'other' && !(e.otherText || '').trim())));

  const setLine = (key, patch) => setLines((prev) => prev.map((l) => {
    if (l.key !== key) return l;
    const next = { ...l, ...patch };
    // Re-suggest while the reason is still ours; once staff pick one it stays.
    if ('next' in patch && !next.reasonTouched) {
      next.reasonKey = suggestReason({ serviceId: next.serviceId, current: next.current, next: Number(next.next) || 0 });
    }
    return next;
  }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const byRow = new Map();
      for (const l of lines) {
        if (!byRow.has(l.rowId)) byRow.set(l.rowId, []);
        byRow.get(l.rowId).push(l);
      }
      const stamp = new Date().toISOString();
      const saved = new Map(); // rowId → services as written
      for (const [rowId, rowLines] of byRow) {
        const row = clientRows.find((r) => r.id === rowId);
        if (!row) continue;
        const services = [...(row.services || [])];
        let touched = false;
        for (const l of rowLines) {
          const neu = round2(l.next);
          if (l.isNew) {
            if (!(neu > 0)) continue;
            services.push({
              service_id: l.serviceId,
              qbo_item_id: l.qboItemId || null,
              fee_engine_service_id: l.feeEngineServiceId || null,
              description: l.description || l.serviceId,
              cadence: 'monthly',
              cadence_months: 1,
              monthly_amount: 0,
              annual_amount: 0,
              approval_status: 'approved',
              approved_by: profile?.id || null,
              approved_at: stamp,
              billing_type: 'recurring',
              ...pendingFields(l, neu, effectiveAt, stamp, 'manual'),
            });
            touched = true;
            continue;
          }
          const s = services[l.idx];
          if (!s) continue;
          if (neu === l.current) {
            if (s.pending_monthly_amount != null) {
              services[l.idx] = { ...s, pending_monthly_amount: null, pending_effective_at: null, pending_uplift_reason: null, pending_uplift_reason_key: null, pending_uplift_staged_at: null, pending_proposal_id: null, pending_changes: null, pending_needs_acceptance: null, pending_build: null };
              touched = true;
            }
            continue;
          }
          // An amount typed here is a manual price; keeping the value a
          // bulk pass staged keeps that pass's strategy.
          const strategy = s.pending_monthly_amount != null && round2(s.pending_monthly_amount) === neu
            ? (s.pending_uplift_strategy || 'manual')
            : 'manual';
          const updated = { ...s, ...pendingFields(l, neu, effectiveAt, s.pending_uplift_staged_at && strategy !== 'manual' ? s.pending_uplift_staged_at : stamp, strategy) };
          if (JSON.stringify(updated) !== JSON.stringify(s)) { services[l.idx] = updated; touched = true; }
        }
        if (touched) { await onSaveRow(rowId, services); saved.set(rowId, services); }
      }
      // Re-read the lines from what was written, so a new service is now
      // an existing line (a second Save must not add it twice) and the
      // dirty check starts again from the saved state.
      setLines(initialLines(clientRows.map((r) => (saved.has(r.id) ? { ...r, services: saved.get(r.id) } : r))));
      return true;
    } catch (e) {
      setError(e.message || String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveAndWrite = async () => {
    if (dirty && !(await save())) return;
    setLetterPreview(false);
    setStep('email');
  };

  const changedCount = lines.filter(isChanged).length;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={shell} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '16px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', letterSpacing: '0.04em' }}>
              {step === 'price' ? 'STEP 1 OF 2 · REPRICE' : 'STEP 2 OF 2 · WRITE TO THE CLIENT'}
            </div>
            <h2 style={{ fontFamily: serif, fontSize: 22, fontWeight: 500, color: '#0f172a', margin: '2px 0 0' }}>{entity.name}</h2>
          </div>
          <KindBadge kind={kind} />
          <button onClick={onOpenClient} style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 6 }} title="Open the client record">
            <ExternalLink size={12} /> Client record
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: 4 }} aria-label="Close"><X size={18} /></button>
        </div>

        {step === 'price' && letterPreview ? (
          // The letter as the client would get it from the prices on
          // screen — nothing needs saving first.
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#f3f5f8' }}>
            <div style={{ padding: '8px 22px', fontSize: 12, color: '#64748b', borderBottom: '1px solid #e5e7eb', background: '#fff' }}>
              Letter preview — from the prices on screen, unsaved. {pdfFilename(entity.name)}
            </div>
            <PdfPreview build={() => buildRepricePdf({ kind, clientName: entity.name, contactName: recipient?.contactName, effectiveAt, lines: letterLines, summary })} buildKey={JSON.stringify([kind, recipient?.contactName, effectiveAt, summary, letterLines.map((l) => [l.serviceId, l.current, l.next, l.reasonKey, l.otherText])])} />
          </div>
        ) : step === 'price' ? (
          <PriceStep
            lines={lines}
            summary={summary}
            effectiveAt={effectiveAt}
            setEffectiveAt={setEffectiveAt}
            setLine={setLine}
            standards={standards}
            drivers={drivers}
            setDrivers={(patch) => { setDrivers((d) => ({ ...d, ...patch })); setSeedNote(null); }}
            driverSources={driverSources}
            relevant={relevant}
            standardsReady={!!feeDefaults}
            onSeedStandard={seedFromStandard}
            seedNote={seedNote}
            onRemoveNew={(key) => setLines((prev) => prev.filter((l) => l.key !== key))}
            adding={adding}
            setAdding={setAdding}
            feServices={feServices}
            priceFor={(svc) => (feeDefaults ? standardFor(svc.id, drivers, feeDefaults) : null)}
            feeDefaults={feeDefaults}
            onAdd={(svc, amount, build) => {
              const target = clientRows.find((r) => r.qbo_recurring_txn_id) || clientRows[0];
              if (!target) return;
              setLines((prev) => [...prev, {
                key: `new-${Date.now()}`, rowId: target.id, idx: null, isNew: true,
                serviceId: svc.lineServiceId, qboItemId: svc.qboItemId, feeEngineServiceId: svc.id,
                description: svc.defaultDescription || svc.label,
                build: build ? { serviceId: svc.id, values: build.values, description: build.description } : null,
                cadence: 'monthly', current: 0, next: String(amount), original: 0,
                // Mid-split, a service added is where the old fee went.
                ...(prev.some((l) => l.reasonKey === 'split' && isChanged(l))
                  ? { reasonKey: 'split', reasonTouched: true }
                  : { reasonKey: 'new_service', reasonTouched: false }),
                otherText: '', extra: [], originalReason: '',
              }]);
              setAdding(false);
            }}
          />
        ) : (
          <EmailStep
            entity={entity}
            kind={kind}
            info={recipient}
            clientRows={clientRows}
            lines={letterLines}
            summary={summary}
            effectiveAt={effectiveAt}
            onBack={() => setStep('price')}
          />
        )}

        {step === 'price' && (
          <div style={{ padding: '12px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: '1 1 260px', fontSize: 12, color: error ? '#b91c1c' : '#64748b' }}>
              {error ? `Save failed: ${error}` : missingReason
                ? 'Give the "Other" reason some words — the client reads it.'
                : `${changedCount} change${changedCount === 1 ? '' : 's'} · saving stages them for Push uplifts; nothing reaches QBO until pushed.`}
            </span>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => setLetterPreview((v) => !v)}
              disabled={changedCount === 0 && !letterPreview}
              title={changedCount === 0 ? 'Change a fee first' : 'See the letter the client would get'}
              style={{ ...BTN.secondary.md, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6, opacity: changedCount === 0 && !letterPreview ? 0.5 : 1 }}
            >
              {letterPreview ? <><ArrowLeft size={14} /> Back to prices</> : <><FileText size={14} /> Preview letter</>}
            </button>
            <button onClick={onClose} disabled={saving} style={BTN.secondary.md}>Cancel</button>
            <button onClick={save} disabled={saving || !dirty || missingReason} style={{ ...BTN.secondary.md, opacity: (!dirty || missingReason) ? 0.5 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={saveAndWrite}
              disabled={saving || missingReason || changedCount === 0}
              title={changedCount === 0 ? 'Change a fee first' : ''}
              style={{ ...BTN.primary.md, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (missingReason || changedCount === 0) ? 0.5 : 1 }}
            >
              {dirty ? 'Save & write to client' : 'Write to client'} <ArrowRight size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step 1 ──────────────────────────────────────────────────────────

function PriceStep({
  lines, summary, effectiveAt, setEffectiveAt, setLine,
  standards, drivers, setDrivers, driverSources, relevant, standardsReady, onSeedStandard, seedNote,
  onRemoveNew, adding, setAdding, feServices, priceFor, feeDefaults, onAdd,
}) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px' }}>
      {/* Old vs new */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 16 }}>
        <PriceCard title="Current" monthly={summary.current} />
        <PriceCard title="New" monthly={summary.next} delta={summary.delta} emphasis />
      </div>

      <StandardPanel
        drivers={drivers} setDrivers={setDrivers} sources={driverSources} relevant={relevant}
        ready={standardsReady} onSeed={onSeedStandard} note={seedNote}
      />

      {/* Table and rail sit side by side on a wide screen and stack on a
          narrow one; the table scrolls sideways rather than clip a column. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '999 1 560px', minWidth: 0, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ ...th, textAlign: 'left' }}>Service</th>
                <th style={th}>Current / mo</th>
                <th style={th} title="At our standard rates, from the fee engine">Standard / mo</th>
                <th style={th}>New / mo</th>
                <th style={th}>Change</th>
                <th style={{ ...th, textAlign: 'left', width: 230 }}>Reason</th>
                <th style={{ ...th, width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const n = asNumbers(l);
                const d = round2(n.next - n.current);
                const changed = d !== 0;
                const bucket = changed ? bucketFor(n) : null;
                return (
                  <tr key={l.key} style={{ borderTop: '1px solid #f1f5f9', background: changed ? '#fcfbff' : '#fff' }}>
                    <td style={{ ...td, textAlign: 'left' }}>
                      <div style={{ fontWeight: 500, color: '#0f172a' }}>{serviceName(l.serviceId)}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>
                        {l.isNew ? 'New service' : l.cadence === 'annual' ? 'Annual service · shown per month' : l.serviceId.includes(':') ? l.serviceId.split(':')[0] : ''}
                      </div>
                      {l.build && (
                        <>
                          <BuildFields
                            compact serviceId={l.build.serviceId} values={l.build.values} feeDefaults={feeDefaults}
                            onChange={(values) => {
                              const p = priceBuild(l.build.serviceId, values, feeDefaults);
                              setLine(l.key, { build: { ...l.build, values, description: p?.description || l.build.description }, ...(p ? { next: String(p.monthly) } : {}) });
                            }}
                          />
                          <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 3 }}>{l.build.description}</div>
                        </>
                      )}
                    </td>
                    <td style={{ ...td, fontFamily: 'monospace', color: changed ? '#94a3b8' : '#0f172a', textDecoration: changed ? 'line-through' : 'none' }}>
                      {fmtGbpDetailed(l.current)}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <StandardCell st={standards[l.key]} current={l.current} onUse={(v) => setLine(l.key, { next: String(v) })} />
                    </td>
                    <td style={{ ...td, padding: '4px 8px' }}>
                      <input
                        type="number" step="0.5" min="0" value={l.next}
                        onChange={(e) => setLine(l.key, { next: e.target.value })}
                        style={{ width: 84, padding: '5px 7px', fontSize: 13, fontFamily: 'monospace', textAlign: 'right', border: `1px solid ${changed ? '#a78bfa' : '#e5e7eb'}`, borderRadius: 6, outline: 'none', boxSizing: 'border-box' }}
                      />
                      {n.current > 0 && (
                        <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>
                          {changed ? `${d > 0 ? '+' : ''}${((d / n.current) * 100).toFixed(1)}%` : ' '}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap', fontFamily: 'monospace', fontWeight: 600, color: d > 0 ? '#15803d' : d < 0 ? '#b91c1c' : '#cbd5e1' }}>
                      {changed ? `${d > 0 ? '+' : ''}${fmtGbpDetailed(d)}` : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'left' }}>
                      {changed ? (
                        <>
                          <select
                            value={l.reasonKey}
                            onChange={(e) => setLine(l.key, { reasonKey: e.target.value, reasonTouched: true })}
                            style={{ ...input, width: '100%' }}
                          >
                            {BUCKETS.map((b) => (
                              <optgroup key={b.key} label={b.label}>
                                {REASONS.filter((r) => r.bucket === b.key).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                              </optgroup>
                            ))}
                          </select>
                          {l.reasonKey === 'other' && (
                            <input
                              autoFocus value={l.otherText} placeholder="Explain in a few words…"
                              onChange={(e) => setLine(l.key, { otherText: e.target.value })}
                              style={{ ...input, width: '100%', marginTop: 4, borderColor: l.otherText.trim() ? '#e5e7eb' : '#fca5a5' }}
                            />
                          )}
                          {bucket && REASON_BY_KEY[l.reasonKey]?.bucket !== bucket && (
                            <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
                              Shown to the client under “{BUCKETS.find((b) => b.key === bucket)?.label}”
                            </div>
                          )}
                          <ExtraChanges line={l} onChange={(extra) => setLine(l.key, { extra, reasonTouched: true })} />
                          {lineNeedsAcceptance(n) && (
                            <div style={{ fontSize: 10.5, color: '#92400e', marginTop: 3 }}>Needs the client&apos;s written acceptance</div>
                          )}
                        </>
                      ) : <span style={{ fontSize: 12, color: '#cbd5e1' }}>No change</span>}
                    </td>
                    <td style={{ ...td, padding: '4px 6px' }}>
                      {l.isNew ? (
                        <IconBtn title="Drop this new service" onClick={() => onRemoveNew(l.key)}><X size={13} /></IconBtn>
                      ) : changed ? (
                        <IconBtn title="Back to the current fee" onClick={() => setLine(l.key, { next: String(l.current), reasonTouched: false })}><RotateCcw size={13} /></IconBtn>
                      ) : (
                        <IconBtn title="Remove this service (fee to £0)" onClick={() => setLine(l.key, { next: '0' })}><Trash2 size={13} /></IconBtn>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <div style={{ padding: '10px 12px', borderTop: '1px solid #f1f5f9', background: '#fafafa' }}>
            {adding
              ? <AddLine services={feServices} priceFor={priceFor} feeDefaults={feeDefaults} takenItems={new Set(lines.map((l) => l.qboItemId).filter(Boolean))} onCancel={() => setAdding(false)} onAdd={onAdd} />
              : <button onClick={() => setAdding(true)} style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={13} /> Add a service</button>}
          </div>
        </div>

        {/* Right rail: where the change comes from */}
        <div style={{ flex: '1 1 280px', maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 8 }}>Where the change comes from</div>
            <MiniWaterfall summary={summary} />
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px', fontSize: 13 }}>
            <SummaryTable summary={summary} />
            <p style={{ fontSize: 11, color: '#94a3b8', margin: '8px 0 0', lineHeight: 1.45 }}>* {OUR_FEES_FOOTNOTE}</p>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 5 }}>New fees apply from</div>
            <input type="date" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} style={{ ...input, width: '100%' }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// Drivers the standard price depends on, and the seed button. Only the
// drivers this client's services use are shown; each says where its
// prefilled value came from, so nobody prices off a guess unknowingly.
function StandardPanel({ drivers, setDrivers, sources, relevant, ready, onSeed, note }) {
  const src = (k) => (sources[k] ? <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 4 }}>· {sources[k]}</span> : null);
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px', marginBottom: 16, background: '#fbfcfd' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: relevant.size ? 10 : 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: '#0f172a' }}>Standard pricing</div>
        <div style={{ fontSize: 11.5, color: '#64748b', flex: '1 1 240px' }}>
          The fee engine&apos;s current rates. Set the drivers, then seed the new fees.
        </div>
        <button onClick={onSeed} disabled={!ready} style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', opacity: ready ? 1 : 0.5 }}>
          <Sparkles size={13} /> Seed new fees from standard
        </button>
      </div>
      {relevant.size > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'flex-end' }}>
          {relevant.has('accounts') && (
            <>
              <DriverField label={<>Accounts{src('accountsType')}</>}>
                <select value={drivers.accountsType} onChange={(e) => setDrivers({ accountsType: e.target.value })} style={{ ...input, width: 120 }}>
                  <option value="trading">Trading</option>
                  <option value="dormant">Dormant</option>
                  <option value="property">Property</option>
                </select>
              </DriverField>
              {drivers.accountsType === 'trading' && (
                <DriverField label={<>Turnover £ / yr{src('turnover')}</>}>
                  <input type="number" min="0" step="1000" value={drivers.turnover} placeholder="e.g. 120000" onChange={(e) => setDrivers({ turnover: e.target.value })} style={{ ...input, width: 130, fontFamily: 'monospace', textAlign: 'right' }} />
                </DriverField>
              )}
              {drivers.accountsType === 'property' && (
                <DriverField label="Properties">
                  <input type="number" min="1" value={drivers.properties} onChange={(e) => setDrivers({ properties: e.target.value })} style={{ ...input, width: 80, textAlign: 'right' }} />
                </DriverField>
              )}
            </>
          )}
          {relevant.has('directors') && (
            <DriverField label={<>Directors{src('directors')}</>}>
              <input type="number" min="0" value={drivers.directors} onChange={(e) => setDrivers({ directors: e.target.value })} style={{ ...input, width: 80, textAlign: 'right' }} />
            </DriverField>
          )}
          {relevant.has('employees') && (
            <>
              <DriverField label={<>Monthly-paid employees{src('employees')}</>}>
                <input type="number" min="0" value={drivers.monthlyEmployees} placeholder="0" onChange={(e) => setDrivers({ monthlyEmployees: e.target.value })} style={{ ...input, width: 90, textAlign: 'right' }} />
              </DriverField>
              <DriverField label="Weekly-paid">
                <input type="number" min="0" value={drivers.weeklyEmployees} placeholder="0" onChange={(e) => setDrivers({ weeklyEmployees: e.target.value })} style={{ ...input, width: 80, textAlign: 'right' }} />
              </DriverField>
            </>
          )}
        </div>
      )}
      {note && <div style={{ fontSize: 12, color: '#15803d', marginTop: 8 }}>{note}</div>}
    </div>
  );
}

function DriverField({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>{label}</span>
      {children}
    </label>
  );
}

// The standard figure for a line — click to use it as the new fee.
// Amber when today's fee is below standard.
function StandardCell({ st, current, onUse }) {
  if (!st) return <span style={{ fontSize: 11.5, color: '#cbd5e1' }} title="No standard rate for this service">—</span>;
  if (st.missing) return <span style={{ fontSize: 11.5, color: '#b45309' }}>set {DRIVER_LABEL[st.missing]}</span>;
  const below = current < st.monthly - 0.005;
  return (
    <button
      onClick={() => onUse(st.monthly)}
      title={`${st.basis} — click to use as the new fee`}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'monospace', fontSize: 13, color: below ? '#b45309' : '#64748b', textDecoration: 'underline', textDecorationColor: '#e2e8f0', textUnderlineOffset: 3 }}
    >
      {fmtGbpDetailed(st.monthly)}
    </button>
  );
}

function PriceCard({ title, monthly, delta, emphasis }) {
  const vat = round2(monthly * VAT_RATE);
  return (
    <div style={{ border: `1px solid ${emphasis ? '#c7d7e3' : '#e5e7eb'}`, background: emphasis ? '#f4f8fb' : '#fff', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'flex-end', gap: 22 }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>{title} · per month, net</div>
        <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'monospace', color: emphasis ? '#193a50' : '#0f172a', marginTop: 2 }}>{fmtGbpDetailed(monthly)}</div>
      </div>
      <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.6, paddingBottom: 3 }}>
        <div>{fmtGbpDetailed(monthly * 12)} a year</div>
        <div>{fmtGbpDetailed(monthly + vat)} / mo inc VAT</div>
      </div>
      {delta != null && delta !== 0 && (
        <div style={{ marginLeft: 'auto', textAlign: 'right', paddingBottom: 3 }}>
          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace', color: delta > 0 ? '#15803d' : '#b91c1c' }}>
            {delta > 0 ? '+' : ''}{fmtGbpDetailed(delta)}
          </div>
          <div style={{ fontSize: 11.5, color: '#64748b' }}>{delta > 0 ? '+' : ''}{fmtGbpDetailed(delta * 12)} a year</div>
        </div>
      )}
    </div>
  );
}

function SummaryTable({ summary }) {
  const rowS = { display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #f1f5f9' };
  const step = (v) => (v === 0 ? <span style={{ color: '#cbd5e1' }}>—</span> : <span style={{ color: v > 0 ? '#15803d' : '#b91c1c' }}>{v > 0 ? '+' : ''}{fmtGbpDetailed(v)}</span>);
  return (
    <div style={{ fontFamily: font }}>
      <div style={{ ...rowS, fontWeight: 600 }}><span>Current fees</span><span style={{ fontFamily: 'monospace' }}>{fmtGbpDetailed(summary.current)}</span></div>
      {visibleBuckets(summary).map((b) => (
        <div key={b.key} style={{ ...rowS, paddingLeft: 10, color: '#475569' }}>
          <span>{b.label}{b.star ? ' *' : ''}</span><span style={{ fontFamily: 'monospace' }}>{step(summary.buckets[b.key])}</span>
        </div>
      ))}
      <div style={{ ...rowS, fontWeight: 600 }}><span>New fees (net)</span><span style={{ fontFamily: 'monospace' }}>{fmtGbpDetailed(summary.next)}</span></div>
      <div style={{ ...rowS, color: '#475569' }}><span>VAT at 20%</span><span style={{ fontFamily: 'monospace' }}>{fmtGbpDetailed(summary.vat)}</span></div>
      <div style={{ ...rowS, borderBottom: 'none', fontWeight: 700, color: '#193a50' }}><span>Total inc VAT</span><span style={{ fontFamily: 'monospace' }}>{fmtGbpDetailed(summary.gross)}</span></div>
      <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>Per month</div>
    </div>
  );
}

// The same waterfall the PDF draws, small, so staff see the shape of
// the letter while pricing. Zero-based, like the PDF.
function MiniWaterfall({ summary }) {
  const steps = [
    { label: 'Now', total: true, v: summary.current },
    ...BUCKETS.filter((b) => summary.buckets[b.key] !== 0).map((b) => ({ label: b.label.replace('Increases in our fees', 'Our fees*').replace('Reductions in our fees', 'Reductions').replace('Fees split into separate services', 'Split out'), v: summary.buckets[b.key] })),
    { label: 'New', total: true, v: summary.next },
  ];
  let run = 0, peak = 0;
  const bars = steps.map((s) => {
    if (s.total) { run = s.v; peak = Math.max(peak, run); return { ...s, from: 0, to: run }; }
    const from = run; run += s.v; peak = Math.max(peak, from, run); return { ...s, from, to: run };
  });
  peak = peak || 1;
  const W = 272, H = 150, top = 16, bottom = 118, slot = W / bars.length, bw = Math.min(34, slot * 0.6);
  const y = (v) => bottom - (v / peak) * (bottom - top);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Waterfall from current to new monthly fee">
      <line x1="0" x2={W} y1={bottom} y2={bottom} stroke="#cbd5e1" />
      {bars.map((b, i) => {
        const cx = slot * i + slot / 2;
        const t = y(Math.max(b.from, b.to)), h = Math.max(1.5, y(Math.min(b.from, b.to)) - t);
        const fill = b.total ? '#193a50' : b.v > 0 ? '#c98a3e' : '#2f855a';
        return (
          <g key={i}>
            <rect x={cx - bw / 2} y={t} width={bw} height={h} rx="2" fill={fill} />
            {i < bars.length - 1 && <line x1={cx + bw / 2} x2={cx + slot - bw / 2} y1={y(b.to)} y2={y(b.to)} stroke="#94a3b8" strokeDasharray="2 2" />}
            <text x={cx} y={t - 4} textAnchor="middle" fontSize="9.5" fontWeight="600" fill={b.total ? '#193a50' : fill} fontFamily="monospace">
              {b.total ? `£${Math.round(b.v)}` : `${b.v > 0 ? '+' : '−'}£${Math.abs(b.v).toFixed(b.v % 1 ? 2 : 0)}`}
            </text>
            <text x={cx} y={bottom + 13} textAnchor="middle" fontSize="9" fill="#475569" fontFamily={font}>
              {b.label.length > 12 ? b.label.split(' ').slice(0, 2).join(' ') : b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Add a service from the fee engine's list — the same services New Quote
// prices, each already mapped to its QuickBooks product. Services whose
// product this client is already billed for are left out: the push would
// refuse a second line on the same product. The amount starts at the
// standard price when the drivers allow one.
function AddLine({ services, priceFor, feeDefaults, takenItems, onCancel, onAdd }) {
  const options = (services || []).filter((s) => !takenItems.has(s.qboItemId));
  const hidden = (services || []).length - options.length;
  const [id, setId] = useState('');
  const svc = options.find((s) => s.id === id) || null;
  const [amount, setAmount] = useState('');
  const [build, setBuild] = useState(null); // builder values, for quantity-priced services
  const std = svc ? priceFor(svc) : null;
  const built = svc && build ? priceBuild(svc.id, build, feeDefaults) : null;
  const pick = (next) => {
    setId(next);
    const s = options.find((o) => o.id === next);
    const values = s ? builderDefaults(s.id, feeDefaults) : null;
    setBuild(values);
    const p = values ? priceBuild(s.id, values, feeDefaults) : (s ? priceFor(s) : null);
    setAmount(p && p.monthly != null ? String(p.monthly) : '');
  };
  const changeBuild = (values) => {
    setBuild(values);
    const p = priceBuild(svc.id, values, feeDefaults);
    if (p) setAmount(String(p.monthly));
  };
  const ok = svc && Number(amount) > 0;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <ServicePicker value={id} options={options} onChange={pick} placeholder="Pick a fee-engine service…" style={{ ...input, width: '100%' }} />
        </div>
        <input type="number" step="0.5" min="0" placeholder="£ / month" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...input, width: 100, fontFamily: 'monospace', textAlign: 'right' }} />
        <button onClick={() => ok && onAdd(svc, Number(amount), build ? { values: build, description: built?.description || '' } : null)} disabled={!ok} style={{ ...BTN.primary.sm, opacity: ok ? 1 : 0.5 }}>Add</button>
        <button onClick={onCancel} style={BTN.secondary.sm}>Cancel</button>
      </div>
      {svc && build && (
        <BuildFields serviceId={svc.id} values={build} feeDefaults={feeDefaults} onChange={changeBuild} />
      )}
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 5 }}>
        {svc
          ? <>QuickBooks product: <strong style={{ color: '#64748b', fontWeight: 500 }}>{svc.qboItemName}</strong>
              {built ? <> · {built.description} = {fmtGbpDetailed(built.monthly)}/mo</>
                : std?.monthly != null ? <> · standard {fmtGbpDetailed(std.monthly)}/mo ({std.basis})</>
                : std?.missing ? <> · set the {DRIVER_LABEL[std.missing]} above for a standard price</>
                : <> · no standard rate — enter the fee</>}</>
          : hidden > 0 ? `${hidden} service${hidden === 1 ? '' : 's'} on products this client is already billed for are not listed.` : '\u00a0'}
      </div>
    </div>
  );
}

// The inputs a quantity-priced service is built from (standardPricing
// BUILDERS): e.g. how often × cost per set for management accounts. Rates
// start at the fee engine's price book and stay editable, as on a quote.
function BuildFields({ serviceId, values, feeDefaults, onChange, compact }) {
  const [showAll, setShowAll] = useState(false);
  const b = BUILDERS[serviceId];
  if (!b || !feeDefaults) return null;
  const fields = b.fields(feeDefaults).filter((f) => !f.advanced || showAll);
  const hasAdvanced = b.fields(feeDefaults).some((f) => f.advanced);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', alignItems: 'flex-end', marginTop: compact ? 4 : 8 }}>
      {fields.map((f) => (
        <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, color: '#64748b' }}>{f.label}</span>
          {f.options ? (
            <select value={values[f.key]} onChange={(e) => onChange({ ...values, [f.key]: Number(e.target.value) })} style={{ ...input, fontSize: 12, padding: '4px 6px' }}>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input type="number" min="0" step={f.step || 1} value={values[f.key]} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
              style={{ ...input, width: 90, fontSize: 12, padding: '4px 6px', fontFamily: 'monospace', textAlign: 'right' }} />
          )}
        </label>
      ))}
      {hasAdvanced && (
        <button onClick={() => setShowAll(!showAll)} style={{ background: 'none', border: 'none', padding: '0 0 6px', fontSize: 11, color: '#1E4560', cursor: 'pointer', fontFamily: font }}>
          {showAll ? 'Fewer' : 'Rates…'}
        </button>
      )}
    </div>
  );
}

// ─── Step 2 ──────────────────────────────────────────────────────────

function EmailStep({ entity, kind, info, clientRows, lines, summary, effectiveAt, onBack }) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [covering, setCovering] = useState('');
  const [busy, setBusy] = useState(null); // 'pdf' | 'view' | 'draft'
  const [drafted, setDrafted] = useState(null);
  const [error, setError] = useState(null);
  const [previewTab, setPreviewTab] = useState('email'); // email | letter

  const [issued, setIssued] = useState(null); // proposal id once recorded

  // First drafts once the contact is known, and again if the kind changes —
  // a notice and a proposal say different things.
  useEffect(() => {
    if (!info) return;
    setTo((t) => t || info.candidates[0]?.addr || '');
    setSubject(composeRepriceEmail({ kind, clientName: entity.name, coveringText: '', effectiveAt, summary }).subject);
    setCovering(defaultCoveringText({ kind, contactName: info.contactName, clientName: entity.name, effectiveAt, lines, summary }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, kind]);

  const email = useMemo(
    () => composeRepriceEmail({ kind, clientName: entity.name, coveringText: covering, effectiveAt, summary }),
    [kind, entity.name, covering, effectiveAt, summary],
  );

  const makePdf = () => buildRepricePdf({ kind, clientName: entity.name, contactName: info?.contactName, effectiveAt, lines, summary });

  const download = async () => {
    setBusy('pdf');
    try { (await makePdf()).save(pdfFilename(entity.name)); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(null); }
  };

  const view = async () => {
    setBusy('view');
    try {
      const doc = await makePdf();
      window.open(URL.createObjectURL(doc.output('blob')), '_blank', 'noopener');
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(null); }
  };

  // The billing row the draft is stamped on: the one carrying the pending
  // change (the template row when there is one), so Push uplifts shows
  // the DRAFT chip against it.
  const billingId = (clientRows.find((r) => (r.services || []).some((s) => s.pending_monthly_amount != null) && r.qbo_recurring_txn_id)
    || clientRows.find((r) => (r.services || []).some((s) => s.pending_monthly_amount != null))
    || clientRows[0])?.id;

  // Record what was issued (fee-proposal edge function). For a proposal
  // this is what holds the staged fees back from Push until the client's
  // written acceptance is recorded.
  const pendingBillingIds = clientRows
    .filter((r) => (r.services || []).some((s) => s.pending_monthly_amount != null))
    .map((r) => r.id);
  const issue = async (gmailDraftId) => {
    const { data, error: fnErr } = await supabase.functions.invoke('fee-proposal', {
      body: {
        action: 'issue',
        entity_id: entity.id,
        kind,
        effective_at: effectiveAt,
        billing_ids: pendingBillingIds,
        lines: lines.map((l) => ({ service: l.serviceId, current: l.current, next: l.next, reason: reasonText(l), reason_key: l.reasonKey, build: l.build?.description || null })),
        summary,
        subject,
        recipient_email: to || null,
        gmail_draft_id: gmailDraftId,
      },
    });
    if (fnErr || !data?.success) throw new Error(`The draft was created but the ${kind} wasn't recorded: ${data?.error || fnErr?.message || 'unknown error'}`);
    setIssued(data.proposal_id);
  };

  const issueWithoutEmail = async () => {
    if (!window.confirm(`Record this ${kind} as issued without an email (for example, sent by post)?`)) return;
    setBusy('issue');
    setError(null);
    try { await issue(null); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(null); }
  };

  const draft = async () => {
    if (!to) { setError('Pick or type a recipient first.'); return; }
    setBusy('draft');
    setError(null);
    try {
      const doc = await makePdf();
      const { data, error: fnErr } = await supabase.functions.invoke('gmail-create-draft', {
        body: {
          billing_id: billingId,
          to,
          subject,
          body_text: email.body,
          body_html: email.bodyHtml,
          attachments: [{ filename: pdfFilename(entity.name), mime_type: 'application/pdf', content_base64: pdfBase64(doc) }],
        },
      });
      if (fnErr || !data?.success) {
        if (data?.code === 'no_gmail_connection') throw new Error('No active Gmail connection — connect one on Push uplifts first.');
        throw new Error(data?.error || fnErr?.message || 'Draft creation failed');
      }
      setDrafted(data.account_email || 'Gmail');
      await issue(data.draft_id || null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexWrap: 'wrap' }}>
        {/* Compose */}
        <div style={{ flex: '1 1 360px', maxWidth: 440, minWidth: 0, borderRight: '1px solid #e5e7eb', padding: '16px 18px', overflow: 'auto', maxHeight: '100%', display: 'flex', flexDirection: 'column', gap: 12, boxSizing: 'border-box' }}>
          {!info ? <p style={{ fontSize: 13, color: '#94a3b8' }}>Loading contacts…</p> : (
            <>
              <Field label="To">
                {info.candidates.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 }}>
                    {info.candidates.map((c) => (
                      <label key={c.addr} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                        <input type="radio" checked={to === c.addr} onChange={() => setTo(c.addr)} />
                        <span style={{ fontFamily: 'monospace', fontSize: 12.5 }}>{c.addr}</span>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>· {c.label}</span>
                      </label>
                    ))}
                  </div>
                )}
                <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Type an address…" style={{ ...input, width: '100%' }} />
                {!info.contactName && (
                  <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 4 }}>No primary contact name on file — check the greeting below.</div>
                )}
              </Field>
              <Field label="Subject">
                <input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ ...input, width: '100%' }} />
              </Field>
              <Field label="Covering note" hint="The summary table, footnote and sign-off follow it automatically.">
                <textarea value={covering} onChange={(e) => setCovering(e.target.value)} rows={14} style={{ ...input, width: '100%', resize: 'vertical', lineHeight: 1.5, fontFamily: font }} />
              </Field>
              <Field label="Attachment">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#f8fafc' }}>
                  <FileText size={16} style={{ color: '#b91c1c', flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pdfFilename(entity.name)}</span>
                  <button onClick={view} disabled={!!busy} style={BTN.secondary.sm}>{busy === 'view' ? '…' : 'View'}</button>
                  <button onClick={download} disabled={!!busy} style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Download size={12} />{busy === 'pdf' ? '…' : 'Save'}</button>
                </div>
              </Field>
            </>
          )}
        </div>

        {/* Preview */}
        <div style={{ flex: '999 1 420px', minWidth: 0, minHeight: 520, height: '100%', display: 'flex', flexDirection: 'column', background: '#f3f5f8' }}>
          <div style={{ padding: '6px 14px', fontSize: 12, color: '#64748b', borderBottom: '1px solid #e5e7eb', background: '#fff', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <PreviewTabs value={previewTab} onChange={setPreviewTab} />
            {previewTab === 'email' ? (
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <strong style={{ color: '#0f172a' }}>{subject}</strong>
                <span style={{ marginLeft: 8 }}>→ {to || 'no recipient'}</span>
              </span>
            ) : (
              <span>{pdfFilename(entity.name)} — as attached to the email</span>
            )}
          </div>
          {previewTab === 'email'
            ? <iframe title="Email preview" srcDoc={email.bodyHtml} sandbox="" style={{ flex: 1, width: '100%', border: 'none' }} />
            : <PdfPreview build={makePdf} buildKey={JSON.stringify([kind, info?.contactName, effectiveAt, summary, lines.map((l) => [l.serviceId, l.current, l.next, l.reasonKey, l.otherText])])} />}
        </div>
      </div>

      <div style={{ padding: '12px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <button onClick={onBack} disabled={!!busy} style={{ ...BTN.secondary.md, display: 'inline-flex', alignItems: 'center', gap: 6 }}><ArrowLeft size={14} /> Back to prices</button>
        <span style={{ flex: '1 1 260px', fontSize: 12, color: error ? '#b91c1c' : drafted ? '#15803d' : '#64748b' }}>
          {error || (issued
            ? (kind === 'proposal'
              ? `${drafted ? `Draft created in ${drafted}. ` : ''}Proposal recorded — once the client accepts by email, record it on Push uplifts.`
              : `${drafted ? `Draft created in ${drafted}. ` : ''}Notice recorded — the new fees are ready to push from ${longDate(effectiveAt)}.`)
            : `Nothing sends from here — the draft goes to Gmail with the letter attached.${kind === 'proposal' ? ' The new fees are held until the client accepts in writing.' : ''}`)}
        </span>
        <div style={{ flex: 1 }} />
        {!issued && (
          <button onClick={issueWithoutEmail} disabled={!!busy || !info} style={{ ...BTN.secondary.md, whiteSpace: 'nowrap' }} title="Sent another way, such as by post">
            {busy === 'issue' ? 'Recording…' : 'Issued without email'}
          </button>
        )}
        <button
          onClick={draft}
          disabled={!!busy || !info || !to || !billingId}
          style={{ ...BTN.primary.md, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!info || !to) ? 0.5 : 1 }}
        >
          <Mail size={14} /> {busy === 'draft' ? 'Creating draft…' : drafted ? 'Create another draft' : 'Create Gmail draft'}
        </button>
      </div>
    </>
  );
}

// More than one reason on a line — e.g. Accounts split out (−£80) and
// then our fee raised (+£6). Each extra reason carries its own amount;
// the line's first reason takes whatever is left, so the line always adds
// up to its new fee.
function ExtraChanges({ line, onChange }) {
  const extra = line.extra || [];
  const comps = componentsOf(asNumbers(line));
  const primary = comps.find((c) => c.primary);
  const set = (i, patch) => onChange(extra.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <div style={{ marginTop: 4 }}>
      {extra.length > 0 && (
        <div style={{ fontSize: 10.5, color: '#64748b', margin: '2px 0 4px' }}>
          First reason: {primary ? `${primary.amount > 0 ? '+' : ''}${fmtGbpDetailed(primary.amount)}` : '£0.00'}
        </div>
      )}
      {extra.map((e, i) => (
        <div key={e.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginTop: 4 }}>
          <select value={e.reasonKey} onChange={(ev) => set(i, { reasonKey: ev.target.value })} style={{ ...input, flex: '1 1 150px', minWidth: 150, fontSize: 12, padding: '4px 6px' }}>
            {BUCKETS.filter((b) => b.key !== 'newService' && b.key !== 'removed').map((b) => (
              <optgroup key={b.key} label={b.label}>
                {REASONS.filter((r) => r.bucket === b.key).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </optgroup>
            ))}
          </select>
          <input type="number" step="0.5" value={e.amount} placeholder="±£" onChange={(ev) => set(i, { amount: ev.target.value })}
            style={{ ...input, width: 70, fontSize: 12, padding: '4px 6px', fontFamily: 'monospace', textAlign: 'right' }} />
          <IconBtn title="Remove this reason" onClick={() => onChange(extra.filter((_, j) => j !== i))}><X size={12} /></IconBtn>
          {e.reasonKey === 'other' && (
            <input value={e.otherText || ''} placeholder="Explain…" onChange={(ev) => set(i, { otherText: ev.target.value })} style={{ ...input, flex: '1 1 100%', fontSize: 12, marginTop: 2 }} />
          )}
        </div>
      ))}
      <button
        onClick={() => onChange([...extra, { id: `x-${Date.now()}`, reasonKey: 'inflation', amount: '', otherText: '' }])}
        style={{ background: 'none', border: 'none', padding: 0, marginTop: 4, fontSize: 11, color: '#1E4560', cursor: 'pointer', fontFamily: font }}
      >+ another reason</button>
    </div>
  );
}

// What this fee change is, from its changes: a notice we push from the
// effective date, or a proposal whose new services wait for the client's
// written acceptance.
function KindBadge({ kind }) {
  const proposal = kind === 'proposal';
  return (
    <span
      title={proposal
        ? 'New services need the client to accept in writing before they reach QuickBooks. Everything else goes ahead from the effective date.'
        : 'Fee changes, splits and removals go ahead from the effective date — no acceptance needed.'}
      style={{
        marginLeft: 12, fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap',
        background: proposal ? '#fef3c7' : '#f1f5f9', color: proposal ? '#92400e' : '#475569',
      }}
    >{proposal ? 'Proposal · new services need acceptance' : 'Fee notice · no acceptance needed'}</span>
  );
}

function PreviewTabs({ value, onChange }) {
  const tab = (key, label) => (
    <button
      onClick={() => onChange(key)}
      style={{
        padding: '4px 10px', fontSize: 12, fontFamily: font, cursor: 'pointer', borderRadius: 6,
        border: `1px solid ${value === key ? '#193a50' : '#e5e7eb'}`,
        background: value === key ? '#193a50' : '#fff', color: value === key ? '#fff' : '#475569',
        fontWeight: value === key ? 600 : 500,
      }}
    >{label}</button>
  );
  return <span style={{ display: 'inline-flex', gap: 4 }}>{tab('email', 'Email')}{tab('letter', 'Letter (PDF)')}</span>;
}

// The fee-review letter, rendered in place: the same buildRepricePdf the
// attachment and the download use, shown through the browser's PDF
// viewer. Rebuilt whenever buildKey changes (a price, reason or date).
function PdfPreview({ build, buildKey }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    let made = null;
    setErr(null);
    (async () => {
      try {
        const doc = await build();
        if (!live) return;
        made = URL.createObjectURL(doc.output('blob'));
        setUrl(made);
      } catch (e) {
        if (live) setErr(e.message || String(e));
      }
    })();
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildKey]);
  if (err) return <div style={{ padding: 20, fontSize: 13, color: '#b91c1c' }}>Couldn&apos;t build the letter: {err}</div>;
  if (!url) return <div style={{ padding: 20, fontSize: 13, color: '#94a3b8' }}>Building the letter…</div>;
  return <iframe title="Letter preview" src={`${url}#view=FitH`} style={{ flex: 1, width: '100%', minHeight: 480, border: 'none', background: '#525659' }} />;
}

// ─── helpers ─────────────────────────────────────────────────────────

function initialLines(clientRows) {
  const out = [];
  for (const r of clientRows) {
    (r.services || []).forEach((s, idx) => {
      if (s.approval_status !== 'approved' || s.recurring_status === 'ending') return;
      if (s.cadence !== 'monthly' && s.cadence !== 'annual') return;
      const current = round2(s.monthly_amount);
      const next = s.pending_monthly_amount != null ? round2(s.pending_monthly_amount) : current;
      const saved = reasonFromSaved(s);
      const serviceId = s.service_id || s.description || 'Service';
      const reasonKey = saved?.reasonKey || suggestReason({ serviceId, current, next });
      const otherText = saved?.otherText || '';
      const extra = saved?.extra || [];
      out.push({
        key: `${r.id}:${idx}`, rowId: r.id, idx, isNew: false,
        serviceId, description: s.description || '',
        qboItemId: s.qbo_item_id != null ? String(s.qbo_item_id) : null,
        feeEngineServiceId: s.fee_engine_service_id || null,
        build: s.pending_build && s.pending_build.values
          ? { serviceId: s.pending_build.fee_engine_service_id, values: s.pending_build.values, description: s.pending_build.description || '' }
          : null,
        cadence: s.cadence, current, next: String(next), original: next,
        reasonKey, otherText, extra, reasonTouched: !!saved,
        // What is stored now: a staged line with no saved reason key (a
        // bulk pass) counts as unsaved until its reason is written.
        originalReason: saved ? reasonSig({ reasonKey, otherText, extra }) : '',
        originalBuild: s.pending_build?.values ? JSON.stringify(s.pending_build.values) : null,
      });
    });
  }
  return out.sort((a, b) => b.current - a.current);
}

function initialEffective(clientRows) {
  const today = new Date().toISOString().slice(0, 10);
  for (const r of clientRows) for (const s of r.services || []) {
    if (s.pending_monthly_amount != null && s.pending_effective_at && s.pending_effective_at >= today) return s.pending_effective_at;
  }
  return firstOfNextMonth();
}

function pendingFields(l, amount, effectiveAt, stagedAt, strategy) {
  const line = { ...l, next: amount };
  return {
    pending_monthly_amount: amount,
    pending_effective_at: effectiveAt,
    pending_uplift_reason: reasonText(line),
    pending_uplift_reason_key: l.reasonKey,
    // Each reason and its amount, and whether the line waits for the
    // client's written acceptance — qbo-push-recurring reads the flag.
    pending_changes: savedChanges(line),
    pending_needs_acceptance: lineNeedsAcceptance(line),
    // How a quantity-priced service was built (e.g. 4 sets a year × £158),
    // so reopening shows it and the letter can say it.
    pending_build: l.build ? { fee_engine_service_id: l.build.serviceId, values: l.build.values, description: l.build.description } : null,
    pending_uplift_staged_at: stagedAt,
    pending_uplift_strategy: strategy,
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const asNumbers = (l) => ({ ...l, next: round2(l.next) });
const isChanged = (l) => round2(l.next) !== l.current;
// Unsaved: a new line, an amount moved from what was loaded, or a
// changed line whose reason differs from the one stored on it.
const reasonSig = (l) => JSON.stringify([l.reasonKey, l.otherText || '', (l.extra || []).map((e) => [e.reasonKey, round2(e.amount), e.otherText || ''])]);
const lineDirty = (l) => l.isNew || round2(l.next) !== l.original || (isChanged(l) && reasonSig(l) !== l.originalReason)
  || (l.build && JSON.stringify(l.build.values) !== l.originalBuild);

function Field({ label, hint, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function IconBtn({ title, onClick, children }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} style={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid transparent', borderRadius: 6, color: '#94a3b8', cursor: 'pointer', padding: 0 }}>
      {children}
    </button>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, fontFamily: font, padding: 16 };
const shell = { background: '#fff', borderRadius: 14, width: 1180, maxWidth: '100%', height: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.3)' };
const th = { padding: '8px 10px', fontSize: 11.5, fontWeight: 600, color: '#64748b', textAlign: 'right', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', textAlign: 'right', verticalAlign: 'top' };
const input = { padding: '6px 9px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', outline: 'none', boxSizing: 'border-box' };
