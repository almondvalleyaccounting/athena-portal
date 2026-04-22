import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Upload, X, Check, ArrowLeft, AlertTriangle, RefreshCw } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { supabase } from '../../../lib/supabase';
import { SOURCES, SYSTEMS, getSource, getSystemLabel } from '../lib/sources';
import { previewFile } from '../lib/parseCsv';
import {
  computeFileHash, createImportRun, markValidated, approveAndStart,
  markComplete, markFailed, markCancelled, findRunningRun,
} from '../lib/importQueries';
import { parseBmClientsCsv } from '../lib/parsers/bmClients';
import { classifyBmProspects, writeBmClients } from '../lib/writers/bmClients';
import { parseBmTasksCsv } from '../lib/parsers/bmTasks';
import { classifyBmTasks, writeBmTasks } from '../lib/writers/bmTasks';

const font = "'Outfit', sans-serif";

export default function ImportView() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { profile } = useAuth();

  const selectedKey = params.get('source') || '';
  const source = useMemo(() => getSource(selectedKey), [selectedKey]);

  const [sessionDone, setSessionDone] = useState({});  // { [sourceKey]: true }

  // Per-source in-flight state lives inside RunPanel (remounts on source change)

  const selectSource = (key) => {
    setParams({ source: key });
  };

  return (
    <div style={{ display: 'flex', minHeight: 'calc(100vh - 120px)', fontFamily: font }}>
      {/* Left: source selector */}
      <div style={{
        width: 280, flexShrink: 0, borderRight: '1px solid #e5e7eb',
        padding: '20px 14px', background: '#fff',
      }}>
        {SYSTEMS.map((sys) => {
          const sysSources = SOURCES.filter((s) => s.system === sys.id);
          return (
            <div key={sys.id} style={{ marginBottom: 20 }}>
              <p style={{
                fontSize: 10, fontWeight: 700, color: '#94a3b8',
                textTransform: 'uppercase', letterSpacing: '0.08em',
                marginBottom: 8, paddingLeft: 6,
              }}>{sys.label}</p>
              {sysSources.map((src) => {
                const active = src.key === selectedKey;
                const coming = src.comingSoon;
                return (
                  <button
                    key={src.key}
                    disabled={coming}
                    onClick={() => !coming && selectSource(src.key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      width: '100%', textAlign: 'left',
                      padding: '7px 10px', borderRadius: 6,
                      border: 'none', background: active ? 'rgba(56,189,248,0.1)' : 'transparent',
                      cursor: coming ? 'not-allowed' : 'pointer',
                      marginBottom: 2, fontFamily: font,
                      color: coming ? '#cbd5e1' : active ? '#0f172a' : '#475569',
                      fontSize: 13, fontWeight: active ? 600 : 400,
                    }}
                  >
                    <span style={{
                      width: 10, height: 10, borderRadius: '50%',
                      border: `1.5px solid ${active ? '#38bdf8' : '#cbd5e1'}`,
                      background: active ? '#38bdf8' : 'transparent',
                      flexShrink: 0,
                    }} />
                    <span style={{ flex: 1 }}>{src.name}</span>
                    {sessionDone[src.key] && <Check size={12} style={{ color: '#15803d' }} />}
                    {coming && (
                      <span style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>Coming soon</span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Right: run panel */}
      <div style={{ flex: 1, padding: '24px 32px' }}>
        {!source ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
            <p style={{ fontSize: 14, color: '#94a3b8' }}>Select a source from the left to begin</p>
          </div>
        ) : (
          <RunPanel
            source={source}
            profile={profile}
            onCompleted={() => setSessionDone((prev) => ({ ...prev, [source.key]: true }))}
            onPickAnother={() => setParams({})}
            onGoStatus={() => navigate('/admin/import')}
            onGoHistory={() => navigate('/admin/import/history')}
            onViewClients={() => navigate('/clients')}
          />
        )}
      </div>
    </div>
  );
}

/* ─── RunPanel ──────────────────────────────────────────────── */
function RunPanel({ source, profile, onCompleted, onPickAnother, onGoStatus, onGoHistory, onViewClients }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [stage, setStage] = useState('upload'); // upload | validated | running | done
  const [validation, setValidation] = useState(null);
  const [parsedRows, setParsedRows] = useState(null);
  const [matches, setMatches] = useState({});          // bm_client_id/bm_task_id -> match info
  const [decisions, setDecisions] = useState({});      // bm_client_id -> confirmed prospect_id (or 'reject')
  const [seenTaskIds, setSeenTaskIds] = useState([]);  // bm_tasks: every task_id in the CSV (drives disappearance sweep)
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [runningLock, setRunningLock] = useState(null);
  const [staff, setStaff] = useState([]);
  const [rechecking, setRechecking] = useState(false);
  const [previewInfo, setPreviewInfo] = useState(null); // keep preview for re-checks

  // Load staff profiles once (cheap, one list) — used by the rollup
  // panels to map BM assignees without leaving this screen.
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('staff_profiles').select('id, name, email, is_active').order('name');
      setStaff((data || []).map((s) => ({ ...s, name: s.name || s.email })));
    })();
  }, []);

  const handleRecheck = async () => {
    if (!parsedRows || source.key !== 'bm_tasks' || !previewInfo) return;
    setRechecking(true);
    try {
      const matchMap = await classifyBmTasks(parsedRows);
      setMatches(matchMap);
      const parsedLike = { rows: parsedRows, warnings: [], skipped: validation?.skippedRows || [], seenTaskIds };
      const v = buildTasksValidation(previewInfo, parsedLike, matchMap);
      // Persist the refreshed validation to the run row.
      if (run?.id) {
        try { await markValidated(run.id, v); } catch {}
      }
      setValidation(v);
    } catch (e) {
      console.error('[DataImport] recheck error:', e);
      setError(e.message || 'Re-check failed');
    }
    setRechecking(false);
  };

  // Reset when source changes (parent remounts key, but safety)
  useEffect(() => {
    setFile(null); setPreview(null); setStage('upload');
    setValidation(null); setParsedRows(null); setMatches({}); setDecisions({});
    setSeenTaskIds([]);
    setRun(null); setError(null);
    (async () => {
      const existing = await findRunningRun(source.key);
      setRunningLock(existing);
    })();
  }, [source.key]);

  const onFilePicked = async (picked) => {
    setError(null);
    if (!picked) return;
    const name = picked.name.toLowerCase();
    const expected = source.accepts;
    if (!name.endsWith(expected)) {
      setError(`This source expects a ${expected.toUpperCase()} file`);
      return;
    }
    if (picked.size > 50 * 1024 * 1024) {
      setError('File too large (max 50 MB)');
      return;
    }
    setFile(picked);
    try {
      const pv = await previewFile(picked);
      setPreview(pv);
    } catch (e) {
      console.error('[DataImport] preview error:', e);
      setError('Could not read file');
    }
  };

  const clearFile = () => {
    setFile(null); setPreview(null); setValidation(null);
    if (run && ['validating', 'ready'].includes(run.status)) {
      markCancelled(run.id).catch(() => {});
    }
    setRun(null); setStage('upload');
  };

  const handleRunValidation = async () => {
    if (!file || !preview) return;
    setError(null);
    try {
      const hash = await computeFileHash(file);
      const created = await createImportRun({
        sourceKey: source.key,
        file,
        fileHash: hash,
        sourceRowCount: preview.rowCount,
        triggeredBy: profile.id,
      });
      setRun(created);
      setPreviewInfo(preview);

      let v;
      if (source.key === 'bm_clients') {
        // Real pipeline
        const text = await file.text();
        const parsed = parseBmClientsCsv(text);
        if (!parsed.headerOk) {
          throw new Error(parsed.headerError || 'Invalid BM Clients header');
        }
        const matchMap = await classifyBmProspects(parsed.rows);
        setParsedRows(parsed.rows);
        setMatches(matchMap);
        // Pre-confirm tier 1/2 matches; tier 3 requires explicit action
        const preDecisions = {};
        for (const [bmId, m] of Object.entries(matchMap)) {
          if (m.tier === 1 || m.tier === 2) preDecisions[bmId] = m.prospect_id;
        }
        setDecisions(preDecisions);

        const rowByBmId = Object.fromEntries(parsed.rows.map((r) => [r.bm_client_id, r]));
        const conversionList = Object.entries(matchMap).map(([bmId, m]) => ({
          bm_client_id: bmId,
          bm_name: rowByBmId[bmId]?.name || null,
          tier: m.tier,
          prospect_id: m.prospect_id,
          prospect_name: m.prospect_name,
          score: m.score,
        }));

        v = {
          sourceRows: preview.rowCount,
          valid: parsed.rows.length,
          warningCount: parsed.warnings.length,
          skippedCount: parsed.skipped.length,
          rowCounts: { entities: parsed.rows.length },
          warnings: parsed.warnings,
          skippedRows: parsed.skipped,
          conversions: conversionList,
          notes: [],
        };
      } else if (source.key === 'bm_tasks') {
        const text = await file.text();
        const parsed = parseBmTasksCsv(text);
        if (!parsed.headerOk) {
          throw new Error(parsed.headerError || 'Invalid BM Tasks header');
        }

        const matchMap = await classifyBmTasks(parsed.rows);
        setParsedRows(parsed.rows);
        setMatches(matchMap);
        setSeenTaskIds(parsed.seenTaskIds);

        v = buildTasksValidation(preview, parsed, matchMap);
      } else {
        // Stubbed for other sources pending their writers
        v = buildStubValidation(source, preview);
      }

      const updated = await markValidated(created.id, v);
      setRun(updated);
      setValidation(v);
      setStage('validated');
    } catch (e) {
      console.error('[DataImport] validation error:', e);
      setError(e.message || 'Validation failed');
      if (run?.id) markFailed(run.id, [{ message: e.message || String(e) }]).catch(() => {});
    }
  };

  // Group conversions by prospect_id — a single Athena prospect may
  // attract multiple BM rows (e.g. "Foursite Inc" vs "Foursite Inc Ltd"
  // both fuzzy-matching "Four Site Inc."). Contested groups force a
  // single-winner choice.
  const conversionGroups = useMemo(() => {
    const list = validation?.conversions || [];
    const byProspect = {};
    for (const c of list) {
      (byProspect[c.prospect_id] ||= []).push(c);
    }
    return Object.values(byProspect).map((members) => ({
      prospect_id: members[0].prospect_id,
      prospect_name: members[0].prospect_name,
      contested: members.length > 1,
      members: [...members].sort((a, b) => (b.score || 1) - (a.score || 1)),
    }));
  }, [validation]);

  const tier3Pending = useMemo(() => {
    if (source.key !== 'bm_clients') return [];
    return (validation?.conversions || []).filter(
      (c) => c.tier === 3 && !(c.bm_client_id in decisions)
    );
  }, [validation, decisions, source.key]);

  // Contested groups are "resolved" when the user has chosen exactly one
  // winner (rest auto-rejected by the panel). Until that happens, Approve
  // is blocked.
  const contestedUnresolved = useMemo(() => {
    return conversionGroups.filter((g) => {
      if (!g.contested) return false;
      const decisionsForGroup = g.members.map((m) => decisions[m.bm_client_id]);
      const winners = decisionsForGroup.filter((d) => d && d !== 'reject');
      return winners.length !== 1;
    }).length;
  }, [conversionGroups, decisions]);

  const handleCancelRun = async () => {
    if (!run) return;
    try {
      await markCancelled(run.id);
    } catch (e) {
      console.error('[DataImport] cancel error:', e);
    }
    setFile(null); setPreview(null); setValidation(null);
    setParsedRows(null); setMatches({}); setDecisions({});
    setRun(null); setStage('upload'); setError(null);
  };

  const handleApprove = async () => {
    setConfirmVisible(false);
    setStage('running');
    try {
      const started = await approveAndStart(run.id, profile.id);
      setRun(started);

      if (source.key === 'bm_clients') {
        // Build approved-conversion map (drop 'reject' entries)
        const approvedDecisions = {};
        for (const [bmId, val] of Object.entries(decisions)) {
          if (val && val !== 'reject') approvedDecisions[bmId] = val;
        }
        const result = await writeBmClients(run.id, parsedRows, approvedDecisions);
        const done = await markComplete(run.id, {
          rowCounts: { entities: result.entities_written },
          errors: result.errors || [],
        });
        setRun(done);
        setValidation((v) => ({
          ...v,
          writeResult: result,
        }));
      } else if (source.key === 'bm_tasks') {
        const result = await writeBmTasks(run.id, parsedRows, seenTaskIds);
        const done = await markComplete(run.id, {
          rowCounts: {
            bm_task_schedule: (result.scheduled || 0) + (result.updated || 0),
          },
          errors: result.errors || [],
        });
        setRun(done);
        setValidation((v) => ({ ...v, writeResult: result }));
      } else {
        // Stubbed
        await new Promise((r) => setTimeout(r, 600));
        const done = await markComplete(run.id, { rowCounts: validation.rowCounts });
        setRun(done);
      }

      setStage('done');
      onCompleted?.();
    } catch (e) {
      console.error('[DataImport] approve error:', e);
      setError(e.message || 'Import failed');
      try { await markFailed(run.id, [{ message: e.message || String(e) }]); } catch {}
      setStage('validated');
    }
  };

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: '#0f172a' }}>
          {getSystemLabel(source.system)} — {source.name}
        </h2>
        {source.tables.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>Populates:</span>
            {source.tables.map((t) => (
              <span key={t} style={pill}>{t}</span>
            ))}
          </div>
        )}
      </div>

      {runningLock && runningLock.id !== run?.id && (
        <div style={banner('amber')}>
          <AlertTriangle size={14} style={{ color: '#d97706' }} />
          Another import for this source is currently running. Wait for it to finish before starting a new one.
        </div>
      )}

      {error && <div style={banner('red')}>{error}</div>}

      {stage === 'upload' && (
        <UploadZone
          source={source}
          file={file}
          preview={preview}
          onFilePicked={onFilePicked}
          onClear={clearFile}
          onValidate={handleRunValidation}
          disabled={!!runningLock && runningLock.id !== run?.id}
        />
      )}

      {stage === 'validated' && validation && (
        <>
          <button onClick={clearFile} style={{ ...btnGhost, marginBottom: 16 }}>
            <ArrowLeft size={12} /> Change file
          </button>
          <ValidationReport
            validation={validation}
            staff={staff}
            onRecheck={source.key === 'bm_tasks' ? handleRecheck : null}
            rechecking={rechecking}
          />
          {validation.conversions?.length > 0 && (
            <ConversionPanel
              groups={conversionGroups}
              decisions={decisions}
              setDecisions={setDecisions}
            />
          )}
          <ApprovePanel
            validation={validation}
            tier3Pending={tier3Pending.length}
            contestedUnresolved={contestedUnresolved}
            onApprove={() => setConfirmVisible(true)}
            onCancel={handleCancelRun}
          />
          {confirmVisible && (
            <ConfirmPrompt
              onCancel={() => setConfirmVisible(false)}
              onConfirm={handleApprove}
            />
          )}
        </>
      )}

      {stage === 'running' && (
        <ProgressView validation={validation} />
      )}

      {stage === 'done' && (

        <ResultView
          source={source}
          validation={validation}
          run={run}
          onPickAnother={onPickAnother}
          onGoStatus={onGoStatus}
          onGoHistory={onGoHistory}
          onViewClients={onViewClients}
        />
      )}
    </div>
  );
}

/* ─── Upload zone ───────────────────────────────────────────── */
function UploadZone({ source, file, preview, onFilePicked, onClear, onValidate, disabled }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = React.useRef(null);

  if (file && preview) {
    return (
      <div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', border: '1px solid #d1fae5', background: '#ecfdf5',
          borderRadius: 8, marginBottom: 12,
        }}>
          <Check size={14} style={{ color: '#15803d' }} />
          <span style={{ fontSize: 13, fontWeight: 500, color: '#065f46' }}>{file.name}</span>
          <span style={{ fontSize: 12, color: '#64748b' }}>
            · {preview.rowCount !== null ? `${preview.rowCount.toLocaleString()} rows detected` : 'XLSX preview not parsed'} {preview.columnCount !== null ? `· ${preview.columnCount} columns` : ''}
          </span>
          <button onClick={onClear} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer' }}>
            <X size={14} style={{ color: '#94a3b8' }} />
          </button>
        </div>
        <button disabled={disabled} onClick={onValidate} style={{ ...btnPrimary, opacity: disabled ? 0.5 : 1 }}>
          Run validation →
        </button>
      </div>
    );
  }

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragging(false);
          const f = e.dataTransfer.files?.[0]; if (f) onFilePicked(f);
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? '#38bdf8' : '#cbd5e1'}`,
          borderRadius: 12, padding: '40px 20px',
          background: dragging ? '#f0f9ff' : '#fafafa',
          cursor: 'pointer', textAlign: 'center',
          transition: 'all 0.15s',
        }}
      >
        <Upload size={28} style={{ color: '#94a3b8', marginBottom: 10 }} />
        <p style={{ fontSize: 14, fontWeight: 500, color: '#1e293b', marginBottom: 4 }}>
          Drop {source.accepts.toUpperCase()} file here
        </p>
        <p style={{ fontSize: 12, color: '#94a3b8' }}>or click to browse</p>
        <input
          ref={inputRef}
          type="file"
          accept={source.accepts}
          style={{ display: 'none' }}
          onChange={(e) => onFilePicked(e.target.files?.[0])}
        />
      </div>
    </div>
  );
}

/* ─── BM Tasks validation builder + rollups ──────────────────
   Rolls the per-row warnings up by *cause* so staff can remediate
   at the root (one alias, one rule) rather than scrolling 1,000s of
   near-identical rows. Raw per-row list is preserved on
   `validation.warnings` for audit but tucked behind a collapse. */
function buildTasksValidation(preview, parsed, matchMap) {
  // Per-row extras for audit (kept short — no jargon).
  const extraWarnings = [];

  // Rollup maps keyed by cause.
  const byAssignee  = new Map(); // bm_assignee_name → { count, sampleTaskIds }
  const byTaskName  = new Map(); // bm_task_name     → { count, sampleTaskIds, sampleServices }
  const byClientRef = new Map(); // client_reference → { count, sampleTaskIds }

  let entityMissing = 0, ruleMissing = 0, assigneeUnmapped = 0;

  for (const r of parsed.rows) {
    const m = matchMap[r.bm_task_id];
    if (!m) continue;
    if (m.entity_match === 'missing') {
      entityMissing++;
      const key = r.client_reference || '(blank)';
      const e = byClientRef.get(key) || { key, count: 0, samples: [] };
      e.count += 1;
      if (e.samples.length < 3) e.samples.push({ row: r._source_row, bm_task_name: r.bm_task_name });
      byClientRef.set(key, e);
      extraWarnings.push({ row: r._source_row, bm_task_id: r.bm_task_id, name: r.bm_task_name, field: 'client', message: `Client reference "${r.client_reference}" not found — task won't attach to a client` });
    }
    if (m.rule_match === 'missing') {
      ruleMissing++;
      const key = r.bm_task_name || '(blank)';
      const e = byTaskName.get(key) || { key, count: 0, samples: [] };
      e.count += 1;
      if (e.samples.length < 3) e.samples.push({ row: r._source_row, client_reference: r.client_reference });
      byTaskName.set(key, e);
      extraWarnings.push({ row: r._source_row, bm_task_id: r.bm_task_id, name: r.bm_task_name, field: 'rule', message: `No scheduling rule — task won't auto-schedule` });
    }
    if (m.assignee_match === 'new_alias' || m.assignee_match === 'alias_only') {
      assigneeUnmapped++;
      const key = r.assignee_name || '(unassigned)';
      const e = byAssignee.get(key) || { key, count: 0, samples: [] };
      e.count += 1;
      if (e.samples.length < 3) e.samples.push({ row: r._source_row, bm_task_name: r.bm_task_name });
      byAssignee.set(key, e);
      extraWarnings.push({ row: r._source_row, bm_task_id: r.bm_task_id, name: r.bm_task_name, field: 'assignee', message: `Assignee "${r.assignee_name}" isn't linked to an Athena staff profile — task will be unassigned` });
    }
  }

  const allWarnings = [...parsed.warnings, ...extraWarnings];
  const schedulable = parsed.rows.length - entityMissing - ruleMissing;

  const rollups = {
    unmappedAssignees: [...byAssignee.values()].sort((a, b) => b.count - a.count),
    missingRules:      [...byTaskName.values()].sort((a, b) => b.count - a.count),
    unknownClients:    [...byClientRef.values()].sort((a, b) => b.count - a.count),
    totals: { entityMissing, ruleMissing, assigneeUnmapped },
  };

  return {
    sourceRows: preview.rowCount,
    valid: schedulable,
    warningCount: allWarnings.length,
    skippedCount: parsed.skipped.length,
    rowCounts: { bm_task_schedule: schedulable },
    warnings: allWarnings,
    skippedRows: parsed.skipped,
    conversions: [],
    notes: [],
    rollups,
  };
}

/* ─── Validation report ─────────────────────────────────────── */
function ValidationReport({ validation, staff, onRecheck, rechecking }) {
  const { sourceRows, valid, warningCount, skippedCount, rowCounts, warnings, skippedRows, notes, rollups } = validation;

  // Rolled-up "needs attention" count — rows that have at least one
  // unresolved cause. Falls back to warnings when rollups aren't built.
  const needsAttention = rollups
    ? (rollups.totals.entityMissing + rollups.totals.ruleMissing + rollups.totals.assigneeUnmapped)
    : warningCount;

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
        overflow: 'hidden', marginBottom: 12,
      }}>
        <StatCell label="Source rows" value={(sourceRows ?? '—').toLocaleString?.() ?? sourceRows ?? '—'} />
        <StatCell label="Will import" value={(valid ?? '—').toLocaleString?.() ?? valid ?? '—'} />
        <StatCell label="Need attention" value={needsAttention.toLocaleString()} />
        <StatCell label="Skipped (errors)" value={skippedCount} />
      </div>

      {Object.keys(rowCounts).length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {Object.entries(rowCounts).map(([t, n]) => (
            <span key={t} style={pillBig}>{Number(n).toLocaleString()} rows → {t}</span>
          ))}
        </div>
      )}

      {notes?.length > 0 && (
        <div style={{ ...banner('slate'), marginBottom: 10 }}>
          {notes.map((n, i) => <div key={i} style={{ fontSize: 12 }}>{n}</div>)}
        </div>
      )}

      {/* Grouped remediation panels — fix once, many warnings vanish. */}
      {rollups && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
              Needs attention · grouped by cause
            </p>
            {onRecheck && (
              <button onClick={onRecheck} disabled={rechecking} style={{ ...btnGhost, fontSize: 12 }}>
                <RefreshCw size={12} style={{ marginRight: 4 }} />
                {rechecking ? 'Re-checking…' : 'Re-check after fixes'}
              </button>
            )}
          </div>

          {rollups.unmappedAssignees.length > 0 && (
            <AssigneeRollupPanel
              groups={rollups.unmappedAssignees}
              staff={staff}
              onChanged={onRecheck}
            />
          )}
          {rollups.missingRules.length > 0 && (
            <RuleRollupPanel
              groups={rollups.missingRules}
              onChanged={onRecheck}
            />
          )}
          {rollups.unknownClients.length > 0 && (
            <UnknownClientsPanel groups={rollups.unknownClients} />
          )}

          {rollups.unmappedAssignees.length === 0
            && rollups.missingRules.length === 0
            && rollups.unknownClients.length === 0 && (
              <div style={{ padding: 14, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, fontSize: 13, color: '#065f46' }}>
                ✓ Nothing to fix — every task will import cleanly.
              </div>
            )}
        </div>
      )}

      {warnings.length > 0 && (
        <details style={{ marginBottom: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: '#64748b', padding: 6 }}>
            Show all {warnings.length.toLocaleString()} per-row messages (audit log)
          </summary>
          <IssueTable issues={warnings} kind="warning" />
        </details>
      )}

      {skippedRows.length > 0 && (
        <details open={skippedRows.length <= 10}>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#1e293b', padding: 6 }}>
            Skipped — will not be imported ({skippedRows.length})
          </summary>
          <IssueTable issues={skippedRows} kind="skipped" />
        </details>
      )}
    </div>
  );
}

/* ─── Rollup panels ─────────────────────────────────────────── */
// Shared frame with optional search filter and scroll-contained body.
// Each row expands to reveal the one-click remediation.
function RollupFrame({ title, tone, summary, search, onSearchChange, searchPlaceholder, children }) {
  const tones = {
    red:    { border: '#fca5a5', bg: '#fef2f2', head: '#991b1b' },
    amber:  { border: '#fcd34d', bg: '#fffbeb', head: '#78350f' },
    slate:  { border: '#cbd5e1', bg: '#f8fafc', head: '#334155' },
  };
  const t = tones[tone] || tones.amber;
  return (
    <div style={{ border: `1px solid ${t.border}`, background: t.bg, borderRadius: 8, marginBottom: 10 }}>
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: t.head, flex: 1 }}>{title}</p>
          {search !== undefined && (
            <input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder || 'Filter…'}
              style={{ ...selectStyle, width: 200, background: '#fff' }}
            />
          )}
        </div>
        {summary && <p style={{ fontSize: 11, color: t.head, opacity: 0.75, marginTop: 2 }}>{summary}</p>}
      </div>
      {/* Cap body height so tall rollups don't dominate — the list
          scrolls inside the panel, but the panel stays compact. */}
      <div style={{ maxHeight: 520, overflowY: 'auto' }}>{children}</div>
    </div>
  );
}

// Resolved groups sort to the bottom + dim, so the eye goes to what's
// left to do. They stay visible for undo/continuity, not hidden.
function partitionAndSort(groups, resolvedKeys) {
  const unresolved = [], resolved = [];
  for (const g of groups) (resolvedKeys.has(g.key) ? resolved : unresolved).push(g);
  return [...unresolved, ...resolved];
}

function useFilteredGroups(groups, search) {
  return useMemo(() => {
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
    return groups.filter((g) => g.key.toLowerCase().includes(q));
  }, [groups, search]);
}

function AssigneeRollupPanel({ groups, staff, onChanged }) {
  const [search, setSearch] = useState('');
  const [resolved, setResolved] = useState(new Set());
  const totalTasks = groups.reduce((n, g) => n + g.count, 0);
  const sorted = useMemo(() => partitionAndSort(groups, resolved), [groups, resolved]);
  const filtered = useFilteredGroups(sorted, search);
  return (
    <RollupFrame
      tone="amber"
      title={`Unmapped assignees · ${groups.length} people, ${totalTasks.toLocaleString()} tasks`}
      summary="These BM staff names aren't linked to an Athena staff profile. Map once — every task they're on becomes assigned."
      search={groups.length > 8 ? search : undefined}
      onSearchChange={setSearch}
      searchPlaceholder="Filter assignees…"
    >
      {filtered.map((g) => (
        <AssigneeRow
          key={g.key}
          group={g}
          staff={staff}
          isResolved={resolved.has(g.key)}
          onResolved={() => setResolved((s) => new Set(s).add(g.key))}
          onChanged={onChanged}
        />
      ))}
      {filtered.length === 0 && (
        <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: '#94a3b8' }}>No matches.</div>
      )}
    </RollupFrame>
  );
}

function AssigneeRow({ group, staff, isResolved, onResolved }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!pick) return;
    setSaving(true);
    try {
      // `pick === 'alias-only'` records the BM name without linking to
      // an Athena staff profile — useful for former staff or people
      // we haven't invited yet. Future tasks stop showing as "unmapped"
      // but remain unassigned until a profile is attached later.
      await supabase.from('bm_staff_aliases').upsert({
        bm_assignee_name: group.key,
        staff_profile_id: pick === 'alias-only' ? null : pick,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: 'bm_assignee_name' });
      onResolved();
      setOpen(false);
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
    setSaving(false);
  };

  const sampleTask = group.samples?.[0]?.bm_task_name;

  return (
    <div style={rollupRowStyle(isResolved)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: isResolved ? '#15803d' : '#0f172a', fontWeight: 500 }}>
            {isResolved && <Check size={12} style={{ display: 'inline', marginRight: 4, color: '#15803d' }} />}
            {group.key}
          </div>
          {sampleTask && !isResolved && (
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>
              e.g. {sampleTask}
            </div>
          )}
        </div>
        <span style={{ fontSize: 11, color: '#64748b' }}>{group.count.toLocaleString()} tasks</span>
        {!isResolved && (
          <button onClick={() => setOpen(!open)} style={{ ...btnSecondary, fontSize: 11, padding: '4px 10px' }}>
            {open ? 'Cancel' : 'Map to Athena staff →'}
          </button>
        )}
      </div>
      {open && !isResolved && (
        <div style={{ padding: '6px 14px 10px 14px', display: 'flex', gap: 8, alignItems: 'center', borderTop: '1px dashed #e5e7eb', flexWrap: 'wrap' }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...selectStyle, minWidth: 200 }}>
            <option value="">— choose Athena staff —</option>
            {staff.filter((s) => s.is_active !== false).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <option disabled>──────────</option>
            <option value="alias-only">Record alias only (not yet in Athena)</option>
          </select>
          <button onClick={save} disabled={!pick || saving} style={{ ...btnPrimary, fontSize: 11, padding: '6px 10px' }}>
            {saving ? 'Saving…' : 'Save mapping'}
          </button>
          <span style={{ fontSize: 11, color: '#64748b' }}>Then hit <b>Re-check after fixes</b>.</span>
        </div>
      )}
    </div>
  );
}

function RuleRollupPanel({ groups, onChanged }) {
  const [search, setSearch] = useState('');
  const [resolved, setResolved] = useState(new Set());
  const totalTasks = groups.reduce((n, g) => n + g.count, 0);
  const sorted = useMemo(() => partitionAndSort(groups, resolved), [groups, resolved]);
  const filtered = useFilteredGroups(sorted, search);
  return (
    <RollupFrame
      tone="amber"
      title={`Task names without a scheduling rule · ${groups.length} names, ${totalTasks.toLocaleString()} tasks`}
      summary="Add one rule per task-name prefix. Service, lead time, hours are pre-filled from the task name — tweak as needed."
      search={groups.length > 8 ? search : undefined}
      onSearchChange={setSearch}
      searchPlaceholder="Filter task names…"
    >
      {filtered.map((g) => (
        <RuleRow
          key={g.key}
          group={g}
          isResolved={resolved.has(g.key)}
          onResolved={() => setResolved((s) => new Set(s).add(g.key))}
          onChanged={onChanged}
        />
      ))}
      {filtered.length === 0 && (
        <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: '#94a3b8' }}>No matches.</div>
      )}
    </RollupFrame>
  );
}

const SERVICE_SUGGESTIONS = ['Accounts', 'Bookkeeping', 'VAT', 'Payroll', 'Personal Tax', 'Corporation Tax', 'Admin', 'CIS', 'Company Secretarial', 'Other'];

// Heuristic service inference from the task name — saves the team
// re-picking "Admin" out of the dropdown for 62 obvious cases.
function inferService(name) {
  const n = (name || '').toLowerCase();
  if (/\bvat\b/.test(n)) return 'VAT';
  if (/payroll|p11d|rti|paye|p60|p45/.test(n)) return 'Payroll';
  if (/bookkeeping|reconcil|bank\s*rec/.test(n)) return 'Bookkeeping';
  if (/self[\s-]*assessment|personal\s*tax|\bsa\b|tax\s*return\s*preparation\s*tax\s*year/.test(n)) return 'Personal Tax';
  if (/corporation\s*tax|\bct600\b|\bct\b\s|ct\s*return/.test(n)) return 'Corporation Tax';
  if (/\bcis\b/.test(n)) return 'CIS';
  if (/company\s*sec|confirmation\s*statement|\bps01\b/.test(n)) return 'Company Secretarial';
  if (/accounts|year[\s-]*end|year\s*end|balance\s*sheet|p\s*\&\s*l/.test(n)) return 'Accounts';
  if (/onboard|new\s*client|setup|registration|engagement/.test(n)) return 'Admin';
  return 'Admin';
}

// Default lead time: annual-looking tasks get 30 days, the rest 14.
function inferLeadDays(name) {
  const n = (name || '').toLowerCase();
  if (/annual|year[\s-]*end|confirmation\s*statement/.test(n)) return 30;
  return 14;
}

// First two words of the task name is a pragmatic default prefix —
// enough to match "VAT Preparation Quarterly End 31/08/2024" against
// "VAT Preparation" without matching "VAT Submission".
function defaultPrefix(name) {
  const words = (name || '').split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).join(' ') || name || '').trim();
}

function RuleRow({ group, isResolved, onResolved }) {
  const [open, setOpen] = useState(false);
  const [prefix, setPrefix] = useState(() => defaultPrefix(group.key));
  const [service, setService] = useState(() => inferService(group.key));
  const [leadDays, setLeadDays] = useState(() => inferLeadDays(group.key));
  const [hours, setHours] = useState(1);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await supabase.from('bm_scheduling_rules').insert({
        name: group.key.slice(0, 80),
        task_name_prefix: prefix.trim() || group.key,
        service,
        lead_time_days: Number(leadDays) || 14,
        standard_hours: Number(hours) || 1,
        assignee_source: 'bm_assignee',
        active: true,
      });
      onResolved();
      setOpen(false);
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
    setSaving(false);
  };

  return (
    <div style={rollupRowStyle(isResolved)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px' }}>
        <span style={{ flex: 1, fontSize: 13, color: isResolved ? '#15803d' : '#0f172a', fontWeight: 500 }}>
          {isResolved && <Check size={12} style={{ display: 'inline', marginRight: 4, color: '#15803d' }} />}
          {group.key}
        </span>
        <span style={{ fontSize: 11, color: '#64748b' }}>{group.count.toLocaleString()} tasks</span>
        {!isResolved && (
          <button onClick={() => setOpen(!open)} style={{ ...btnSecondary, fontSize: 11, padding: '4px 10px' }}>
            {open ? 'Cancel' : 'Add scheduling rule →'}
          </button>
        )}
      </div>
      {open && !isResolved && (
        <div style={{ padding: '10px 14px', borderTop: '1px dashed #e5e7eb' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 90px 90px', gap: 8, alignItems: 'end' }}>
            <label style={miniLabel}>
              <span>Matches task names starting with</span>
              <input value={prefix} onChange={(e) => setPrefix(e.target.value)} style={selectStyle} />
            </label>
            <label style={miniLabel}>
              <span>Service</span>
              <select value={service} onChange={(e) => setService(e.target.value)} style={selectStyle}>
                {SERVICE_SUGGESTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label style={miniLabel}>
              <span>Lead (days)</span>
              <input type="number" min={1} value={leadDays} onChange={(e) => setLeadDays(e.target.value)} style={selectStyle} />
            </label>
            <label style={miniLabel}>
              <span>Std hours</span>
              <input type="number" min={0} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} style={selectStyle} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button onClick={save} disabled={saving || !prefix.trim()} style={{ ...btnPrimary, fontSize: 11, padding: '6px 10px' }}>
              {saving ? 'Saving…' : 'Save rule'}
            </button>
            <span style={{ fontSize: 11, color: '#64748b' }}>
              Default assignee inherited from BM. Edit later in Workflow → Rules.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function UnknownClientsPanel({ groups }) {
  const [search, setSearch] = useState('');
  const totalTasks = groups.reduce((n, g) => n + g.count, 0);
  const filtered = useFilteredGroups(groups, search);
  return (
    <RollupFrame
      tone="red"
      title={`Unknown client references · ${groups.length} references, ${totalTasks.toLocaleString()} tasks`}
      summary="These BM client references don't match an Athena entity. Run the BM Clients import first — or tasks will import but won't attach to a client."
      search={groups.length > 8 ? search : undefined}
      onSearchChange={setSearch}
      searchPlaceholder="Filter references…"
    >
      {filtered.map((g) => (
        <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid rgba(252,165,165,0.3)' }}>
          <span style={{ flex: 1, fontSize: 13, color: '#0f172a', fontFamily: 'monospace' }}>{g.key}</span>
          <span style={{ fontSize: 11, color: '#64748b' }}>{g.count.toLocaleString()} tasks</span>
          {g.samples[0]?.bm_task_name && (
            <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              e.g. {g.samples[0].bm_task_name}
            </span>
          )}
        </div>
      ))}
      {filtered.length === 0 && (
        <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: '#94a3b8' }}>No matches.</div>
      )}
    </RollupFrame>
  );
}

const miniLabel = {
  display: 'flex', flexDirection: 'column', gap: 3,
  fontSize: 10, fontWeight: 600, color: '#94a3b8',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};

function rollupRowStyle(done) {
  return {
    borderBottom: '1px solid rgba(252,211,77,0.4)',
    background: done ? 'rgba(220,252,231,0.4)' : 'transparent',
  };
}

const selectStyle = {
  fontSize: 12, padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 6,
  background: '#fff', color: '#1e293b', outline: 'none', fontFamily: font,
};

function IssueTable({ issues, kind }) {
  const [limit, setLimit] = useState(50);
  const shown = issues.slice(0, limit);
  const fieldColor = kind === 'skipped' ? '#991b1b' : '#b45309';
  return (
    <div style={{ paddingLeft: 8, paddingRight: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: font }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={ithRow}>Row</th>
            <th style={ithRow}>BM ID</th>
            <th style={{ ...ithRow, minWidth: 160 }}>Client</th>
            <th style={ithRow}>Field</th>
            <th style={{ ...ithRow, width: '100%' }}>{kind === 'skipped' ? 'Reason' : 'Message'}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((it, i) => (
            <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
              <td style={itdRow}>{it.row ?? '—'}</td>
              <td style={{ ...itdRow, fontFamily: 'monospace', color: '#64748b' }}>{it.bm_client_id || '—'}</td>
              <td style={{ ...itdRow, color: '#0f172a' }}>{it.name || '—'}</td>
              <td style={{ ...itdRow, color: fieldColor, fontWeight: 500 }}>{it.field || '—'}</td>
              <td style={{ ...itdRow, color: '#475569' }}>{it.message || it.reason || JSON.stringify(it)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {issues.length > limit && (
        <button onClick={() => setLimit(limit + 100)} style={{ ...btnGhost, fontSize: 11, marginTop: 6 }}>
          Show {Math.min(100, issues.length - limit)} more of {issues.length - limit}
        </button>
      )}
    </div>
  );
}

function ConversionPanel({ groups, decisions, setDecisions }) {
  const totalMembers = groups.reduce((n, g) => n + g.members.length, 0);
  const contestedGroups = groups.filter((g) => g.contested);
  const simpleGroups = groups.filter((g) => !g.contested);

  const setOne = (bmId, value) => {
    setDecisions((d) => {
      const next = { ...d };
      if (value === undefined) delete next[bmId];
      else next[bmId] = value;
      return next;
    });
  };

  // For contested groups: picking a winner auto-rejects siblings.
  const pickWinner = (group, winnerBmId) => {
    setDecisions((d) => {
      const next = { ...d };
      for (const m of group.members) {
        next[m.bm_client_id] = (m.bm_client_id === winnerBmId) ? group.prospect_id : 'reject';
      }
      return next;
    });
  };
  const clearGroup = (group) => {
    setDecisions((d) => {
      const next = { ...d };
      for (const m of group.members) delete next[m.bm_client_id];
      return next;
    });
  };
  const rejectAllInGroup = (group) => {
    setDecisions((d) => {
      const next = { ...d };
      for (const m of group.members) next[m.bm_client_id] = 'reject';
      return next;
    });
  };

  return (
    <div style={{
      background: '#fef3c7', border: '1px solid #fcd34d',
      borderRadius: 10, padding: 16, marginBottom: 16,
    }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: '#78350f', marginBottom: 4 }}>
        ⚡ Prospect conversions — {totalMembers} BM row(s) matched to {groups.length} Athena prospect(s)
      </p>
      <p style={{ fontSize: 12, color: '#92400e', marginBottom: 12 }}>
        These Athena prospects match incoming BrightManager clients. BrightManager becomes the source of truth on conversion.
      </p>

      {contestedGroups.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: '#78350f', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Contested — pick one winner per prospect
          </p>
          {contestedGroups.map((g) => {
            const chosen = g.members.find((m) => decisions[m.bm_client_id] && decisions[m.bm_client_id] !== 'reject');
            return (
              <div key={g.prospect_id} style={{
                padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.6)',
                border: '1px solid #fcd34d', marginBottom: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#0f172a' }}>
                    Athena prospect: {g.prospect_name}
                  </span>
                  <span style={{ flex: 1 }} />
                  {chosen ? (
                    <button onClick={() => clearGroup(g)} style={{ ...btnGhost, fontSize: 11 }}>Clear</button>
                  ) : (
                    <button onClick={() => rejectAllInGroup(g)} style={{ ...btnGhost, fontSize: 11 }}>
                      Skip all — keep as prospect
                    </button>
                  )}
                </div>
                {g.members.map((m) => {
                  const isWinner = decisions[m.bm_client_id] && decisions[m.bm_client_id] !== 'reject';
                  const isRejected = decisions[m.bm_client_id] === 'reject';
                  return (
                    <label key={m.bm_client_id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
                      background: isWinner ? '#dcfce7' : isRejected ? '#fee2e2' : 'transparent',
                    }}>
                      <input
                        type="radio"
                        name={`prospect-${g.prospect_id}`}
                        checked={!!isWinner}
                        onChange={() => pickWinner(g, m.bm_client_id)}
                      />
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#78350f', width: 90 }}>{m.bm_client_id}</span>
                      <span style={{ flex: 1, fontSize: 12, color: '#1e293b' }}>
                        {m.bm_name || '—'}
                        <span style={{ color: '#94a3b8', marginLeft: 6 }}>
                          ({m.tier === 3 ? `${Math.round((m.score || 0) * 100)}% name` : `tier ${m.tier}`})
                        </span>
                      </span>
                    </label>
                  );
                })}
                <p style={{ fontSize: 11, color: '#92400e', marginTop: 6 }}>
                  Others in this group will create new entities (prospect not converted for them).
                </p>
              </div>
            );
          })}
        </div>
      )}

      {simpleGroups.length > 0 && (
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, color: '#78350f', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Matches — confirm or skip
          </p>
          {simpleGroups.map((g) => {
            const m = g.members[0];
            const decided = decisions[m.bm_client_id];
            const tier = m.tier;
            const preConfirmed = (tier === 1 || tier === 2);
            const confirmed = decided === m.prospect_id;
            const rejected = decided === 'reject';

            return (
              <div key={m.bm_client_id} style={convRow}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#78350f', width: 90 }}>{m.bm_client_id}</span>
                <div style={{ flex: 1, fontSize: 12, color: '#1e293b', lineHeight: 1.4 }}>
                  <div><b>BM:</b> {m.bm_name || '—'}</div>
                  <div><b>Athena:</b> {m.prospect_name}
                    <span style={{ color: '#94a3b8', marginLeft: 6 }}>
                      ({tier === 3 ? `${Math.round((m.score || 0) * 100)}% name` : `tier ${tier}`})
                    </span>
                  </div>
                </div>
                {confirmed && <span style={{ fontSize: 11, color: '#15803d', marginRight: 6 }}>✓ Convert</span>}
                {rejected && <span style={{ fontSize: 11, color: '#991b1b', marginRight: 6 }}>✗ Skip — new entity</span>}
                {!decided && preConfirmed && <span style={{ fontSize: 11, color: '#15803d', marginRight: 6 }}>✓ Convert (pre-confirmed)</span>}
                {!decided && !preConfirmed && (
                  <>
                    <button onClick={() => setOne(m.bm_client_id, m.prospect_id)} style={{ ...btnSecondary, fontSize: 11, padding: '4px 10px' }}>Confirm</button>
                    <button onClick={() => setOne(m.bm_client_id, 'reject')} style={{ ...btnGhost, fontSize: 11 }}>Skip</button>
                  </>
                )}
                {(decided || preConfirmed) && (
                  <button onClick={() => {
                    if (confirmed) setOne(m.bm_client_id, 'reject');
                    else if (rejected) setOne(m.bm_client_id, m.prospect_id);
                    else if (preConfirmed && !decided) setOne(m.bm_client_id, 'reject');
                  }} style={{ ...btnGhost, fontSize: 11 }}>
                    {confirmed ? 'Reject' : rejected ? 'Undo' : 'Reject'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ApprovePanel({ validation, tier3Pending, contestedUnresolved, onApprove, onCancel }) {
  const blocked = tier3Pending > 0 || contestedUnresolved > 0;
  const blockReason = contestedUnresolved > 0
    ? 'Resolve contested prospect groups before importing'
    : tier3Pending > 0
      ? 'Review all Tier 3 prospect matches before importing'
      : undefined;
  return (
    <div style={{
      marginTop: 18, padding: 18, borderTop: '2px solid #e5e7eb',
    }}>
      <p style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
        Ready to import
      </p>
      <div style={{
        background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10,
        padding: 16, marginBottom: 14, fontSize: 13,
      }}>
        <p style={{ fontWeight: 600, color: '#0f172a', marginBottom: 8 }}>Import summary</p>
        {Object.entries(validation.rowCounts).map(([t, n]) => (
          <div key={t} style={{ display: 'flex', gap: 16 }}>
            <span style={{ width: 140, color: '#475569' }}>{t}</span>
            <span style={{ fontFamily: 'monospace', color: '#0f172a' }}>{Number(n).toLocaleString()} rows</span>
          </div>
        ))}
        <div style={{ height: 8 }} />
        <div style={{ display: 'flex', gap: 16, color: '#475569', flexWrap: 'wrap' }}>
          <span>Skipped: <b>{validation.skippedCount}</b></span>
          <span>Warnings: <b>{validation.warningCount}</b></span>
          {tier3Pending > 0 && <span>Tier 3 to action: <b>{tier3Pending}</b></span>}
          {contestedUnresolved > 0 && <span style={{ color: '#991b1b' }}>Contested groups: <b>{contestedUnresolved}</b></span>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={onApprove}
          disabled={blocked}
          title={blockReason}
          style={{ ...btnPrimary, flex: 1, justifyContent: 'center', padding: 14, fontSize: 14, opacity: blocked ? 0.5 : 1, cursor: blocked ? 'not-allowed' : 'pointer' }}
        >
          Approve and import to Supabase
        </button>
        <button
          onClick={onCancel}
          style={{ ...btnSecondary, padding: 14, fontSize: 14, color: '#991b1b', borderColor: '#fca5a5' }}
        >
          Cancel import
        </button>
      </div>
    </div>
  );
}

function ConfirmPrompt({ onCancel, onConfirm }) {
  return (
    <div style={{
      marginTop: 12, padding: 14,
      background: '#fef3c7', border: '1px solid #fcd34d',
      borderRadius: 10, display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <AlertTriangle size={16} style={{ color: '#d97706' }} />
      <span style={{ flex: 1, fontSize: 13, color: '#78350f' }}>
        This will write to the live database. This action cannot be undone.
      </span>
      <button onClick={onCancel} style={btnSecondary}>Cancel</button>
      <button onClick={onConfirm} style={btnPrimary}>Confirm import</button>
    </div>
  );
}

function ProgressView({ validation }) {
  return (
    <div style={{
      padding: 20, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
    }}>
      <p style={{ fontSize: 14, fontWeight: 500, color: '#0f172a', marginBottom: 12 }}>Writing to Supabase…</p>
      {Object.entries(validation.rowCounts).map(([t, n]) => (
        <div key={t} style={{ display: 'flex', gap: 12, fontSize: 13, padding: '4px 0' }}>
          <span style={{ width: 140, color: '#475569' }}>{t}</span>
          <span style={{ color: '#94a3b8' }}>{Number(n).toLocaleString()} rows · pending</span>
        </div>
      ))}
    </div>
  );
}

function ResultView({ source, validation, run, onPickAnother, onGoStatus, onGoHistory, onViewClients }) {
  const wr = validation.writeResult;
  const hasRealWrite = !!wr;
  // Does this source populate entities? (controls whether "View clients" shortcut shows)
  const touchesEntities = source?.tables?.includes('entities');
  return (
    <div style={{
      padding: 20, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10,
    }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: '#065f46', marginBottom: 4 }}>
        Import {hasRealWrite ? 'complete' : 'logged'}.
      </p>
      <p style={{ fontSize: 12, color: '#047857', marginBottom: 14 }}>
        Run ID: <code style={{ fontSize: 11 }}>{run.id}</code>
      </p>
      {hasRealWrite && source.key === 'bm_clients' ? (
        <>
          <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>entities written</span><span style={resultNum}>{wr.entities_written.toLocaleString()}</span></div>
          <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>prospects converted</span><span style={resultNum}>{wr.prospects_converted.toLocaleString()}</span></div>
          {wr.errors?.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#991b1b' }}>
                Row-level errors ({wr.errors.length})
              </summary>
              <div style={{ fontSize: 11, color: '#991b1b', paddingLeft: 14, paddingTop: 6 }}>
                {wr.errors.slice(0, 20).map((e, i) => (
                  <div key={i}>• {e.bm_client_id || '—'}: {e.message}</div>
                ))}
              </div>
            </details>
          )}
        </>
      ) : hasRealWrite && source.key === 'bm_tasks' ? (
        <>
          <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>new tasks scheduled</span><span style={resultNum}>{(wr.scheduled || 0).toLocaleString()}</span></div>
          <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>tasks updated</span><span style={resultNum}>{(wr.updated || 0).toLocaleString()}</span></div>
          {wr.overridden_skipped > 0 && (
            <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>tasks with manual override (date untouched)</span><span style={resultNum}>{wr.overridden_skipped.toLocaleString()}</span></div>
          )}
          {wr.tasks_completed > 0 && (
            <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>tasks completed (disappeared)</span><span style={resultNum}>{wr.tasks_completed.toLocaleString()}</span></div>
          )}
          {wr.flags && (
            <div style={{ marginTop: 10, padding: 10, background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: '#78350f', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Reconciliation flags raised
              </p>
              {Object.entries(wr.flags).filter(([, n]) => n > 0).length === 0 ? (
                <p style={{ fontSize: 12, color: '#92400e' }}>None — clean import.</p>
              ) : Object.entries(wr.flags).filter(([, n]) => n > 0).map(([k, n]) => (
                <div key={k} style={{ fontSize: 12, color: '#78350f', padding: '2px 0' }}>
                  • <code style={{ fontSize: 11 }}>{k}</code>: <b>{n}</b>
                </div>
              ))}
            </div>
          )}
          {wr.errors?.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#991b1b' }}>
                Row-level errors ({wr.errors.length})
              </summary>
              <div style={{ fontSize: 11, color: '#991b1b', paddingLeft: 14, paddingTop: 6 }}>
                {wr.errors.slice(0, 20).map((e, i) => (
                  <div key={i}>• {e.bm_task_id || '—'}: {e.message}</div>
                ))}
              </div>
            </details>
          )}
        </>
      ) : hasRealWrite ? (
        Object.entries(validation.rowCounts).map(([t, n]) => (
          <div key={t} style={resultRow}>
            <Check size={12} style={{ color: '#15803d' }} />
            <span style={{ width: 180, color: '#065f46' }}>{t}</span>
            <span style={resultNum}>{Number(n).toLocaleString()} rows written</span>
          </div>
        ))
      ) : (
        Object.entries(validation.rowCounts).map(([t, n]) => (
          <div key={t} style={resultRow}>
            <Check size={12} style={{ color: '#15803d' }} />
            <span style={{ width: 180, color: '#065f46' }}>{t}</span>
            <span style={resultNum}>{Number(n).toLocaleString()} rows (logged only)</span>
          </div>
        ))
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button onClick={onGoStatus} style={btnPrimary}>Back to Status</button>
        <button onClick={onPickAnother} style={btnSecondary}>Pick another source</button>
        {touchesEntities && hasRealWrite && wr.entities_written > 0 && (
          <button onClick={onViewClients} style={btnSecondary}>View clients</button>
        )}
        <button onClick={onGoHistory} style={btnSecondary}>View in History</button>
      </div>
    </div>
  );
}

/* ─── Stub validation ────────────────────────────────────── */
function buildStubValidation(source, preview) {
  const sourceRows = preview.rowCount;
  const notes = [];
  const rowCounts = {};
  if (preview.kind === 'xlsx') {
    notes.push('XLSX preview not yet implemented — row counts shown below are placeholders based on the target tables.');
    for (const t of source.tables) rowCounts[t] = 0;
  } else {
    for (const t of source.tables) rowCounts[t] = sourceRows ?? 0;
  }
  return {
    sourceRows: sourceRows ?? null,
    valid: sourceRows ?? null,
    warningCount: 0,
    skippedCount: 0,
    rowCounts,
    warnings: [],
    skippedRows: [],
    conversions: [],
    notes,
  };
}

/* ─── Styles ───────────────────────────────────────────────── */
function StatCell({ label, value }) {
  return (
    <div style={{ padding: '14px 18px', borderRight: '1px solid #e5e7eb' }}>
      <p style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 18, fontWeight: 600, color: '#0f172a' }}>{value}</p>
    </div>
  );
}

function banner(tone) {
  const tones = {
    amber: { bg: '#fef3c7', border: '#fcd34d', color: '#78350f' },
    red: { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b' },
    slate: { bg: '#f8fafc', border: '#e5e7eb', color: '#475569' },
  };
  const t = tones[tone] || tones.slate;
  return {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 14px', borderRadius: 8,
    background: t.bg, border: `1px solid ${t.border}`,
    color: t.color, fontSize: 13, marginBottom: 14,
  };
}

const pill = {
  fontSize: 11, padding: '2px 8px', borderRadius: 999,
  background: '#f1f5f9', color: '#475569',
};
const pillBig = {
  fontSize: 12, padding: '4px 10px', borderRadius: 999,
  background: '#f0f9ff', color: '#0e7fe0', fontWeight: 500,
};
const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 13, fontWeight: 600, padding: '8px 14px',
  background: '#0f172a', border: 'none', borderRadius: 8,
  color: '#fff', cursor: 'pointer', fontFamily: font,
};
const btnSecondary = {
  fontSize: 13, fontWeight: 500, padding: '8px 14px',
  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
  color: '#1e293b', cursor: 'pointer', fontFamily: font,
};
const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 12, padding: '6px 10px',
  background: 'none', border: 'none',
  color: '#64748b', cursor: 'pointer', fontFamily: font,
};
const convRow = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.5)',
  marginBottom: 4,
};
const resultRow = { display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, padding: '3px 0' };
const resultNum = { color: '#065f46', fontFamily: 'monospace' };
const ithRow = { textAlign: 'left', padding: '6px 8px', fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' };
const itdRow = { padding: '6px 8px', fontSize: 12, verticalAlign: 'top' };
