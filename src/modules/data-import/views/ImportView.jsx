import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Upload, X, Check, ArrowLeft, AlertTriangle, RefreshCw, Loader2 } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { supabase } from '../../../lib/supabase';
import { SOURCES, SYSTEMS, getSource, getSystemLabel } from '../lib/sources';
import { previewFile } from '../lib/parseCsv';
import {
  computeFileHash, createImportRun, markValidated, approveAndStart,
  markComplete, markFailed, markCancelled, findRunningRun,
  fetchExcludedTaskPrefixes, saveExcludedTaskPrefixes,
} from '../lib/importQueries';
import { isNstTask } from '../lib/writers/bmTasks';
import { parseBmClientsCsv } from '../lib/parsers/bmClients';
import { classifyBmProspects, writeBmClients, fetchArchiveCandidates, archiveBmClients, raiseBmImportTasks, fetchRefChanges, rekeyBmClients } from '../lib/writers/bmClients';
import { parseBmTasksCsv } from '../lib/parsers/bmTasks';
import { classifyBmTasks, writeBmTasks } from '../lib/writers/bmTasks';
import { BTN } from '../../../lib/buttonStyles';
import { brand } from '../../../lib/tokens';

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
                fontSize: 11, fontWeight: 700, color: '#94a3b8',
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
                      fontSize: 14, fontWeight: active ? 600 : 400,
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
                      <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>Coming soon</span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Right: run panel */}
      <div style={{ flex: 1, minWidth: 0, padding: '24px 32px' }}>
        {!source ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
            <p style={{ fontSize: 14.5, color: '#94a3b8' }}>Select a source from the left to begin</p>
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
  // Which agent-authorisation columns this BM export turned out to carry.
  const [agentColumns, setAgentColumns] = useState([]);
  // People, keyed on BM's Person Internal Reference: how many the upload
  // describes, and any reference carrying two different people.
  const [personSummary, setPersonSummary] = useState(null);
  const [personRefCollisions, setPersonRefCollisions] = useState([]);
  const [matches, setMatches] = useState({});          // bm_client_id/bm_task_id -> match info
  const [decisions, setDecisions] = useState({});      // bm_client_id -> confirmed prospect_id (or 'reject')
  const [archiveSelection, setArchiveSelection] = useState({}); // bm_clients: bm_client_id -> bool (archive on approve?)
  const [rekeySelection, setRekeySelection] = useState({});     // bm_clients: old bm_client_id -> bool (move to new reference on approve?)
  const [seenTaskIds, setSeenTaskIds] = useState([]);  // bm_tasks: every task_id in the CSV (drives disappearance sweep)
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [validating, setValidating] = useState(false);
  const [runningLock, setRunningLock] = useState(null);
  const [staff, setStaff] = useState([]);
  const [rechecking, setRechecking] = useState(false);
  const [previewInfo, setPreviewInfo] = useState(null); // keep preview for re-checks
  const [excludedPrefixes, setExcludedPrefixes] = useState([]);
  const [prefixCatalogue, setPrefixCatalogue] = useState([]);

  // Load staff profiles once (cheap, one list) — used by the rollup
  // panels to map BM assignees without leaving this screen.
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('staff_profiles').select('id, name, email, is_active').order('name');
      setStaff((data || []).map((s) => ({ ...s, name: s.name || s.email })));
    })();
  }, []);

  // Load saved exclusions + prefix catalogue for the bm_tasks source.
  useEffect(() => {
    if (source.key !== 'bm_tasks') return;
    (async () => {
      try {
        const [excluded, rules, defaults] = await Promise.all([
          fetchExcludedTaskPrefixes(),
          supabase.from('bm_scheduling_rules').select('name, task_name_prefix, active').eq('active', true),
          supabase.from('task_type_schedule_defaults').select('name, task_name_prefix, is_active').eq('is_active', true),
        ]);
        const byPrefix = new Map();
        for (const r of (rules.data || [])) {
          if (!r.task_name_prefix) continue;
          byPrefix.set(r.task_name_prefix, { label: r.name || r.task_name_prefix, prefix: r.task_name_prefix });
        }
        for (const d of (defaults.data || [])) {
          if (!d.task_name_prefix) continue;
          byPrefix.set(d.task_name_prefix, { label: d.name || d.task_name_prefix, prefix: d.task_name_prefix });
        }
        setPrefixCatalogue([...byPrefix.values()].sort((a, b) => a.label.localeCompare(b.label)));
        setExcludedPrefixes(excluded);
      } catch (e) {
        console.warn('[DataImport] failed to load exclusion catalogue:', e);
      }
    })();
  }, [source.key]);

  const toggleExclusion = async (prefix) => {
    const next = excludedPrefixes.includes(prefix)
      ? excludedPrefixes.filter((p) => p !== prefix)
      : [...excludedPrefixes, prefix];
    setExcludedPrefixes(next);
    try {
      await saveExcludedTaskPrefixes(next);
    } catch (e) {
      alert('Could not save exclusion: ' + e.message);
      // Revert optimistic update
      setExcludedPrefixes(excludedPrefixes);
    }
  };

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
    setPersonSummary(null); setPersonRefCollisions([]);
    setArchiveSelection({});
    setRekeySelection({});
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
    if (!file || !preview || validating) return;
    setError(null);
    setValidating(true);
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
        setAgentColumns(parsed.agentColumns || []);
        setPersonSummary(parsed.personSummary || null);
        setPersonRefCollisions(parsed.personRefCollisions || []);
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

        // Disappearance check: active BM entities NOT in this upload are
        // candidates for archiving (they were archived/removed in BM). The
        // user reviews and can deselect any of these before approving.
        const presentBmIds = parsed.rows.map((r) => r.bm_client_id).filter(Boolean);
        const archiveCandidates = await fetchArchiveCandidates(presentBmIds);
        // Default: archive every candidate. User unticks to keep one active.
        setArchiveSelection(
          Object.fromEntries(archiveCandidates.map((c) => [c.bm_client_id, true]))
        );

        // Some "missing" clients are in the upload under a new Internal
        // Reference. Archiving them would lose a live client: the incoming row
        // fails on its company number, and the old one is archived. A company
        // number match is moved across by default; a name-only match is
        // offered unticked.
        const refChanges = await fetchRefChanges(parsed.rows);
        setRekeySelection(
          Object.fromEntries(refChanges.map((c) => [c.old_bm_client_id, c.match === 'company_number']))
        );

        v = {
          sourceRows: preview.rowCount,
          valid: parsed.rows.length,
          warningCount: parsed.warnings.length,
          skippedCount: parsed.skipped.length,
          rowCounts: { entities: parsed.rows.length },
          warnings: parsed.warnings,
          skippedRows: parsed.skipped,
          conversions: conversionList,
          archiveCandidates,
          refChanges,
          presentCount: presentBmIds.length,
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
    } finally {
      setValidating(false);
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

  // Reference changes the user has left ticked: moved to the new reference
  // before the upsert.
  const rekeyToApply = useMemo(() => {
    return (validation?.refChanges || []).filter((c) => rekeySelection[c.old_bm_client_id]);
  }, [validation, rekeySelection]);

  // Archive candidates, less any client that is really in the upload under a
  // new reference. A company-number match never falls back to archiving:
  // unticking it leaves the client alone (its incoming row then fails on the
  // company number and goes on the admin list). An unticked name match is
  // judged a different client, so the old one is a genuine departure.
  const archiveCandidates = useMemo(() => {
    const changes = validation?.refChanges || [];
    const kept = new Set(
      changes
        .filter((c) => c.match === 'company_number' || rekeySelection[c.old_bm_client_id])
        .map((c) => c.old_bm_client_id)
    );
    return (validation?.archiveCandidates || []).filter((c) => !kept.has(c.bm_client_id));
  }, [validation, rekeySelection]);

  // bm_client_ids the user has left ticked for archiving.
  const archiveToApply = useMemo(() => {
    return archiveCandidates.filter((c) => archiveSelection[c.bm_client_id]).map((c) => c.bm_client_id);
  }, [archiveCandidates, archiveSelection]);

  const handleCancelRun = async () => {
    if (!run) return;
    try {
      await markCancelled(run.id);
    } catch (e) {
      console.error('[DataImport] cancel error:', e);
    }
    setFile(null); setPreview(null); setValidation(null);
    setParsedRows(null); setMatches({}); setDecisions({});
    setPersonSummary(null); setPersonRefCollisions([]);
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
        // Re-key first, so the upsert below finds each client on its new
        // reference rather than inserting a second record for it.
        let rekeyResult = { rekeyed: 0, refused: [] };
        if (rekeyToApply.length) {
          rekeyResult = await rekeyBmClients(run.id, rekeyToApply);
        }

        const result = await writeBmClients(run.id, parsedRows, approvedDecisions);

        // Disappearance sweep: archive the BM clients the user left ticked.
        // Runs after the upsert so a client that's both present and (somehow)
        // in the candidate set never gets archived out from under itself.
        let archiveResult = { archived: 0 };
        if (archiveToApply.length) {
          archiveResult = await archiveBmClients(run.id, archiveToApply);
        }

        const done = await markComplete(run.id, {
          rowCounts: {
            entities: result.entities_written,
            ...(rekeyResult.rekeyed ? { rekeyed: rekeyResult.rekeyed } : {}),
            ...(archiveResult.archived ? { archived: archiveResult.archived } : {}),
          },
          errors: result.errors || [],
        });
        setRun(done);

        // The findings this run recorded become tasks on the admin list. The
        // preview panels have always shown them and the browser has always
        // thrown them away — BLACR01, COLLS02 and SHAWW01 have been reported
        // on every import since April and are still shared in BM. Runs after
        // markComplete because the row-level errors only exist from then.
        const tidyUps = await raiseBmImportTasks(run.id);

        setValidation((v) => ({
          ...v,
          writeResult: { ...result, rekeyed: rekeyResult.rekeyed, rekey_refused: rekeyResult.refused || [], archived: archiveResult.archived, tidy_ups: tidyUps },
        }));
      } else if (source.key === 'bm_tasks') {
        // Apply persisted task-type exclusions before writing. Any row
        // whose bm_task_name matches an excluded prefix is dropped from
        // both parsedRows and seenTaskIds — effectively treating it as
        // "not present in this CSV", so the disappearance sweep will
        // delete any pre-existing schedule rows for those types.
        const isExcluded = (name) =>
          !!name && excludedPrefixes.some((p) => name.startsWith(p));
        const effectiveRows = parsedRows.filter((r) => !isExcluded(r.bm_task_name));
        const droppedIds = new Set(
          parsedRows.filter((r) => isExcluded(r.bm_task_name)).map((r) => r.bm_task_id).filter(Boolean)
        );
        const effectiveSeen = seenTaskIds.filter((id) => !droppedIds.has(id));

        const result = await writeBmTasks(run.id, effectiveRows, effectiveSeen);
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

  const noun = NOUNS[source.key] || 'rows';
  const stepIndex = { upload: 0, validated: 1, running: 2, done: 3 }[stage] ?? 0;

  // What has to be settled before Import is allowed, each with where it lives.
  const blockers = [];
  if (contestedUnresolved > 0) {
    blockers.push({ text: `${contestedUnresolved} prospect ${contestedUnresolved === 1 ? 'group needs' : 'groups need'} one winner`, target: 'import-conversions' });
  }
  if (tier3Pending.length > 0) {
    blockers.push({ text: `${tier3Pending.length} prospect ${tier3Pending.length === 1 ? 'match needs' : 'matches need'} Convert or Keep separate`, target: 'import-conversions' });
  }

  const decisionCount = source.key === 'bm_clients'
    ? (validation?.conversions?.length || 0) + (validation?.refChanges?.length || 0) + archiveCandidates.length
    : null;
  const hasClientDecisions = source.key === 'bm_clients' && decisionCount > 0;
  const excludedCount = source.key === 'bm_tasks' && parsedRows
    ? parsedRows.filter((r) => r.bm_task_name && excludedPrefixes.some((p) => r.bm_task_name.startsWith(p))).length
    : 0;

  const detailBits = validation ? [
    source.key !== 'bm_clients' && validation.warningCount ? `${validation.warningCount} per-row messages` : null,
    source.key === 'bm_clients' ? 'people and contacts' : null,
  ].filter(Boolean) : [];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 19, fontWeight: 600, color: '#0f172a' }}>
          {getSystemLabel(source.system)} — {source.name}
        </h2>
        {source.blurb && <p style={{ fontSize: 13.5, color: '#64748b', marginTop: 3 }}>{source.blurb}</p>}
      </div>

      <Steps current={stepIndex} />

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
          validating={validating}
          disabled={!!runningLock && runningLock.id !== run?.id}
        />
      )}

      {stage === 'validated' && validation && (
        <>
          <FileBar file={file} preview={previewInfo} onChange={clearFile} />

          <ValidationReport
            validation={validation}
            staff={staff}
            decisionCount={decisionCount}
            onRecheck={source.key === 'bm_tasks' ? handleRecheck : null}
            rechecking={rechecking}
          />

          {source.key === 'bm_clients' && (
            <>
              <SectionTitle note={hasClientDecisions ? 'Each of these changes what the import does. Work down the list.' : null}>
                Check before importing
              </SectionTitle>
              {!hasClientDecisions && (
                <div style={okBox}>✓ Nothing needs a decision. Every client in the file will import.</div>
              )}
              {validation.conversions?.length > 0 && (
                <div id="import-conversions">
                  <ConversionPanel
                    groups={conversionGroups}
                    decisions={decisions}
                    setDecisions={setDecisions}
                  />
                </div>
              )}
              {validation.refChanges?.length > 0 && (
                <RefChangesPanel
                  changes={validation.refChanges}
                  selection={rekeySelection}
                  setSelection={setRekeySelection}
                />
              )}
              {archiveCandidates.length > 0 && (
                <ArchiveCandidatesPanel
                  candidates={archiveCandidates}
                  presentCount={validation.presentCount}
                  selection={archiveSelection}
                  setSelection={setArchiveSelection}
                />
              )}
            </>
          )}

          <SkippedPanel skipped={validation.skippedRows} />
          {source.key === 'bm_clients' && <WarningsPanel warnings={validation.warnings} />}
          {source.key === 'bm_clients' && <PersonRefCollisionPanel collisions={personRefCollisions} />}

          {source.key === 'bm_tasks' && parsedRows && (
            <Collapsible
              title="Task types to import"
              summary={excludedCount ? `${excludedCount} rows left out by your saved choices` : 'All task types included'}
            >
              <TaskTypeExclusionsPanel
                parsedRows={parsedRows}
                catalogue={prefixCatalogue}
                excluded={excludedPrefixes}
                onToggle={toggleExclusion}
              />
            </Collapsible>
          )}

          {detailBits.length > 0 && (
            <Collapsible title="Details" summary={detailBits.join(' · ')}>
              {source.key !== 'bm_clients' && <ValidationDetails validation={validation} />}
              {source.key === 'bm_clients' && parsedRows && (
                <>
                  <PeoplePanel summary={personSummary} rowCount={parsedRows.length} />
                  <AgentColumnsPanel columns={agentColumns} />
                </>
              )}
            </Collapsible>
          )}

          <ImportBar
            noun={noun}
            count={validation.valid ?? 0}
            rekeyCount={rekeyToApply.length}
            archiveCount={archiveToApply.length}
            skippedCount={validation.skippedCount || 0}
            blockers={blockers}
            confirming={confirmVisible}
            onImport={() => setConfirmVisible(true)}
            onBack={() => setConfirmVisible(false)}
            onConfirm={handleApprove}
            onCancel={handleCancelRun}
          />
        </>
      )}

      {stage === 'running' && (
        <ProgressView noun={noun} count={validation?.valid ?? 0} />
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

const NOUNS = { bm_clients: 'clients', bm_tasks: 'tasks' };

/* ─── Steps ─────────────────────────────────────────────────── */
// Where you are in the import: upload → review → import. `current` is the
// index of the step in progress; 3 means all done.
function Steps({ current }) {
  const labels = ['Upload the file', 'Review', 'Import'];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
      {labels.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const on = done || active;
        return (
          <React.Fragment key={label}>
            {i > 0 && <span style={{ flex: '0 0 28px', height: 1, background: on ? brand.solid : '#cbd5e1' }} />}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12.5, fontWeight: 700,
                background: on ? brand.solid : '#fff',
                color: on ? '#fff' : '#94a3b8',
                border: `1.5px solid ${on ? brand.solid : '#cbd5e1'}`,
              }}>
                {done ? <Check size={13} /> : i + 1}
              </span>
              <span style={{ fontSize: 14, fontWeight: active ? 600 : 500, color: active ? '#0f172a' : done ? '#334155' : '#94a3b8' }}>
                {label}
              </span>
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function FileBar({ file, preview, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', marginBottom: 14,
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13.5,
    }}>
      <Check size={14} style={{ color: '#15803d', flexShrink: 0 }} />
      <span style={{ fontWeight: 500, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file?.name}</span>
      {preview?.rowCount != null && <span style={{ color: '#64748b', whiteSpace: 'nowrap' }}>· {preview.rowCount.toLocaleString()} rows</span>}
      <button onClick={onChange} style={{ ...BTN.secondary.sm, ...btnIcon, marginLeft: 'auto' }}>
        <ArrowLeft size={12} /> Use a different file
      </button>
    </div>
  );
}

function SectionTitle({ children, note }) {
  return (
    <div style={{ margin: '22px 0 10px' }}>
      <h3 style={{ fontSize: 15.5, fontWeight: 600, color: '#0f172a' }}>{children}</h3>
      {note && <p style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>{note}</p>}
    </div>
  );
}

// A closed-by-default box for what is worth knowing but asks nothing of you.
function Collapsible({ title, summary, children }) {
  return (
    <details style={{ marginTop: 14, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10 }}>
      <summary style={{ cursor: 'pointer', padding: '12px 16px', fontSize: 14.5 }}>
        <span style={{ fontWeight: 600, color: '#0f172a' }}>{title}</span>
        {summary && <span style={{ fontSize: 13, color: '#64748b', marginLeft: 10 }}>{summary}</span>}
      </summary>
      <div style={{ padding: '0 16px 16px' }}>{children}</div>
    </details>
  );
}

/* ─── Import bar ────────────────────────────────────────────────
   Pinned to the bottom of the screen while you review, so the one button
   that does the work is always in sight. It used to sit below every panel.
   ─────────────────────────────────────────────────────────── */
function ImportBar({ noun, count, rekeyCount, archiveCount, skippedCount, blockers, confirming, onImport, onBack, onConfirm, onCancel }) {
  const blocked = blockers.length > 0;
  const n = Number(count).toLocaleString();
  const extras = [
    rekeyCount ? `${rekeyCount} moved to a new BM reference` : null,
    archiveCount ? `${archiveCount} archived` : null,
    skippedCount ? `${skippedCount} skipped` : null,
  ].filter(Boolean);
  const amber = confirming || blocked;

  return (
    <div style={{
      position: 'sticky', bottom: 0, zIndex: 10, marginTop: 22,
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '12px 16px',
      background: amber ? '#fffbeb' : '#fff',
      border: `1px solid ${amber ? '#fcd34d' : '#cbd5e1'}`,
      borderRadius: 10, boxShadow: '0 -6px 20px rgba(15,23,42,0.08)',
    }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        {confirming ? (
          <>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: '#78350f' }}>Import {n} {noun}? This can&apos;t be undone.</div>
            {archiveCount > 0 && (
              <div style={{ fontSize: 13, color: '#92400e' }}>{archiveCount} client{archiveCount === 1 ? '' : 's'} will be archived.</div>
            )}
          </>
        ) : blocked ? (
          <>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: '#78350f', display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={14} style={{ color: '#d97706' }} /> Before you can import
            </div>
            {blockers.map((b) => (
              <div key={b.text} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#92400e', marginTop: 4 }}>
                <span>{b.text}</span>
                {b.target && (
                  <button
                    onClick={() => document.getElementById(b.target)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                    style={BTN.secondary.sm}
                  >
                    Show me
                  </button>
                )}
              </div>
            ))}
          </>
        ) : (
          <>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: '#0f172a' }}>Ready to import {n} {noun}</div>
            {extras.length > 0 && <div style={{ fontSize: 13, color: '#64748b' }}>{extras.join(' · ')}</div>}
          </>
        )}
      </div>
      {confirming ? (
        <>
          <button onClick={onBack} style={BTN.secondary.md}>Back</button>
          <button onClick={onConfirm} style={{ ...BTN.primary.md, ...btnIcon }}>Yes, import {n} {noun}</button>
        </>
      ) : (
        <>
          <button onClick={onCancel} style={BTN.danger.md}>Cancel import</button>
          <button
            onClick={onImport}
            disabled={blocked}
            style={{ ...BTN.primary.md, ...btnIcon, opacity: blocked ? 0.45 : 1, cursor: blocked ? 'not-allowed' : 'pointer' }}
          >
            Import {n} {noun}
          </button>
        </>
      )}
    </div>
  );
}

const okBox = {
  padding: 14, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8,
  fontSize: 14, color: '#065f46', marginBottom: 12,
};

/* ─── Upload zone ───────────────────────────────────────────── */
function UploadZone({ source, file, preview, onFilePicked, onClear, onValidate, validating, disabled }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = React.useRef(null);

  const picked = file && preview ? (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', border: '1px solid #d1fae5', background: '#ecfdf5',
        borderRadius: 8, marginBottom: 14,
      }}>
        <Check size={14} style={{ color: '#15803d', flexShrink: 0 }} />
        <span style={{ fontSize: 14, fontWeight: 500, color: '#065f46', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
        <span style={{ fontSize: 13, color: '#64748b', whiteSpace: 'nowrap' }}>
          {preview.rowCount !== null ? `· ${preview.rowCount.toLocaleString()} rows` : ''}
        </span>
        <button onClick={onClear} disabled={validating} style={{ ...BTN.secondary.sm, ...btnIcon, marginLeft: 'auto' }}>
          <X size={12} /> Remove
        </button>
      </div>
      <button
        disabled={disabled || validating}
        onClick={onValidate}
        style={{ ...BTN.primary.md, ...btnIcon, opacity: disabled ? 0.45 : 1, cursor: disabled || validating ? 'not-allowed' : 'pointer' }}
      >
        {validating ? (
          <><Loader2 size={14} className="animate-spin" /> Checking {preview.rowCount ? `${preview.rowCount.toLocaleString()} rows` : 'the file'}…</>
        ) : (
          <>Check the file →</>
        )}
      </button>
      {validating && (
        <p style={{ fontSize: 13, color: '#64748b', marginTop: 8 }}>
          Matching every row against Athena. This takes up to 30 seconds and changes nothing yet.
        </p>
      )}
      {!validating && (
        <p style={{ fontSize: 13, color: '#64748b', marginTop: 8 }}>
          Nothing is written until you press Import at the end.
        </p>
      )}
    </div>
  ) : (
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
        background: dragging ? '#f0f9ff' : '#fff',
        cursor: 'pointer', textAlign: 'center',
        transition: 'all 0.15s',
      }}
    >
      <Upload size={28} style={{ color: '#94a3b8', marginBottom: 10 }} />
      <p style={{ fontSize: 14.5, fontWeight: 500, color: '#1e293b', marginBottom: 10 }}>
        Drop the {source.accepts.toUpperCase()} file here
      </p>
      <span style={{ ...BTN.secondary.sm, display: 'inline-block' }}>Choose file</span>
      <input
        ref={inputRef}
        type="file"
        accept={source.accepts}
        style={{ display: 'none' }}
        onChange={(e) => onFilePicked(e.target.files?.[0])}
      />
    </div>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(220px, 1fr)', gap: 18, alignItems: 'start' }}>
      {picked}
      {source.pullSteps?.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
          <p style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a', marginBottom: 8 }}>
            Getting the file from {getSystemLabel(source.system)}
          </p>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#475569', lineHeight: 1.7, listStyle: 'decimal' }}>
            {source.pullSteps.map((s) => <li key={s}>{s}</li>)}
          </ol>
        </div>
      )}
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
      if (e.samples.length < 3) e.samples.push({ row: r._source_row, bm_task_name: r.bm_task_name, client_name: r.client_name });
      byClientRef.set(key, e);
      extraWarnings.push({ row: r._source_row, bm_task_id: r.bm_task_id, name: r.bm_task_name, field: 'client', message: `Client reference "${r.client_reference}" not found — task won't attach to a client` });
    }
    if (m.rule_match === 'missing') {
      // NST: tasks are BrightManager's equivalent of Athena Quick Tasks
      // — one-off, ad-hoc, disappear with BM. Don't surface them in the
      // rule-missing rollup, and don't count them as "needs attention" —
      // they're expected to import without rules.
      if (r.bm_task_name && /^\s*NST\s*[:\-]/i.test(r.bm_task_name)) {
        continue;
      }
      // Roll up by *task type* (period end stripped) so one rule
      // covers every "Self Assessment Accounts Preparation" variant,
      // not one per period.
      const type = stripPeriodSuffix(r.bm_task_name) || r.bm_task_name || '(blank)';
      ruleMissing++;
      const e = byTaskName.get(type) || { key: type, count: 0, samples: [] };
      e.count += 1;
      if (e.samples.length < 3) e.samples.push({ row: r._source_row, client_reference: r.client_reference, raw_name: r.bm_task_name });
      byTaskName.set(type, e);
      extraWarnings.push({ row: r._source_row, bm_task_id: r.bm_task_id, name: r.bm_task_name, field: 'rule', message: `No scheduling rule — task won't auto-schedule` });
    }
    if (m.assignee_match === 'new_alias' || m.assignee_match === 'alias_only') {
      assigneeUnmapped++;
      const key = r.assignee_name || '(unassigned)';
      const e = byAssignee.get(key) || { key, count: 0, samples: [] };
      e.count += 1;
      if (e.samples.length < 3) e.samples.push({ row: r._source_row, bm_task_name: r.bm_task_name });
      byAssignee.set(key, e);
      extraWarnings.push({ row: r._source_row, bm_task_id: r.bm_task_id, name: r.bm_task_name, field: 'assignee', message: `Assignee "${r.assignee_name}" isn't linked to a staff member — task will be unassigned` });
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
function ValidationReport({ validation, staff, decisionCount, onRecheck, rechecking }) {
  const { sourceRows, valid, skippedCount, notes, rollups } = validation;

  // References someone chose to ignore stop asking for a decision, so they
  // don't count towards "To check" (the panel lists them separately).
  const [ignoredRefs, setIgnoredRefs] = useState(() => new Set());
  useEffect(() => {
    if (!rollups) return undefined;
    let live = true;
    supabase.from('import_ignored_bm_refs').select('bm_client_id').then(({ data }) => {
      if (live) setIgnoredRefs(new Set((data || []).map((r) => r.bm_client_id)));
    });
    return () => { live = false; };
  }, [rollups]);

  // "To check" is what asks something of you: the task rollups, or the
  // client decisions (prospect matches, reference changes, departures).
  const toCheck = rollups
    ? rollups.unmappedAssignees.length + rollups.missingRules.length
      + rollups.unknownClients.filter((g) => !ignoredRefs.has(g.key)).length
    : (decisionCount ?? 0);

  return (
    <div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
        overflow: 'hidden', marginBottom: 12,
      }}>
        <StatCell label="Rows in file" value={fmtCount(sourceRows)} />
        <StatCell label="Will import" value={fmtCount(valid)} />
        <StatCell label="To check" value={fmtCount(toCheck)} tone={toCheck > 0 ? 'amber' : null} />
        <StatCell label="Won't import" value={fmtCount(skippedCount)} tone={skippedCount > 0 ? 'red' : null} />
      </div>

      {notes?.length > 0 && (
        <div style={{ ...banner('slate'), marginBottom: 10 }}>
          {notes.map((n, i) => <div key={i} style={{ fontSize: 13 }}>{n}</div>)}
        </div>
      )}

      {/* Grouped by cause: fix one alias or rule and every task it covers clears. */}
      {rollups && (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
            <SectionTitle note={toCheck > 0 ? 'Each fix covers every task in its group. Re-check when you have made them.' : null}>
              Check before importing
            </SectionTitle>
            {onRecheck && toCheck > 0 && (
              <button onClick={onRecheck} disabled={rechecking} style={{ ...BTN.secondary.sm, ...btnIcon, marginBottom: 10 }}>
                <RefreshCw size={12} className={rechecking ? 'animate-spin' : undefined} />
                {rechecking ? 'Re-checking…' : 'Re-check'}
              </button>
            )}
          </div>

          {rollups.unknownClients.length > 0 && (
            <UnknownClientsPanel groups={rollups.unknownClients} onChanged={onRecheck} />
          )}
          {rollups.unmappedAssignees.length > 0 && (
            <AssigneeRollupPanel groups={rollups.unmappedAssignees} staff={staff} onChanged={onRecheck} />
          )}
          {rollups.missingRules.length > 0 && (
            <RuleRollupPanel groups={rollups.missingRules} onChanged={onRecheck} />
          )}
          {toCheck === 0 && (
            <div style={okBox}>✓ Nothing to fix. Every task will import cleanly.</div>
          )}
        </>
      )}
    </div>
  );
}

// Rows that will not import at all. Always on screen, never folded away:
// each one is a client or task Athena will not have until BrightManager is fixed.
function SkippedPanel({ skipped }) {
  if (!skipped?.length) return null;
  const noRef = skipped.some((s) => /Internal Reference|Client Reference/i.test(`${s.field || ''} ${s.reason || ''}`));
  return (
    <RollupFrame
      tone="red"
      title={`Won't import · ${skipped.length} ${skipped.length === 1 ? 'row' : 'rows'}`}
      summary={noRef
        ? 'Missing a reference in BrightManager. Add it there and re-export. Each one also goes on the admin task list.'
        : 'Fix these in BrightManager and re-export.'}
    >
      <IssueTable issues={skipped} kind="skipped" />
    </RollupFrame>
  );
}

// Rows that import but carry a data problem, grouped by what the problem is,
// so one BrightManager fix is one line here rather than scattered rows.
function WarningsPanel({ warnings }) {
  const groups = useMemo(() => {
    const byMsg = new Map();
    for (const w of warnings || []) {
      // One reference, two people: shown once, in its own panel.
      if (/is shared by \d+ different people/i.test(w.message || '')) continue;
      const raw = w.message || w.reason || 'Other';
      const key = raw.charAt(0).toUpperCase() + raw.slice(1);
      const g = byMsg.get(key) || { key, field: w.field, rows: [] };
      g.rows.push(w);
      byMsg.set(key, g);
    }
    return [...byMsg.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [warnings]);
  if (!groups.length) return null;
  const rowCount = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <RollupFrame
      tone="amber"
      title={`Imports, but check in BrightManager · ${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`}
      summary="These rows import. Each problem below is fixed once in BrightManager."
    >
      {groups.map((g) => (
        <div key={g.key} style={{ padding: '9px 14px', borderBottom: '1px solid rgba(252,211,77,0.4)' }}>
          <div style={{ fontSize: 13.5, color: '#0f172a', fontWeight: 500 }}>
            {g.key} <span style={{ color: '#64748b', fontWeight: 400 }}>· {g.rows.length}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 14, rowGap: 2, fontSize: 12.5, color: '#475569', marginTop: 3 }}>
            {g.rows.map((r) => (
              <span key={`${r.row}-${r.bm_client_id}`} style={{ whiteSpace: 'nowrap' }}>
                {r.name || '—'}
                {r.bm_client_id && <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}> {r.bm_client_id}</span>}
              </span>
            ))}
          </div>
        </div>
      ))}
    </RollupFrame>
  );
}

// Everything per-row that doesn't stop a row importing.
function ValidationDetails({ validation }) {
  const { warnings } = validation;
  if (!warnings?.length) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <p style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a', margin: '6px 0' }}>
        Warnings · {warnings.length.toLocaleString()} {warnings.length === 1 ? 'row' : 'rows'}
      </p>
      <p style={{ fontSize: 12.5, color: '#64748b', marginBottom: 6 }}>
        These rows still import. Fix them in BrightManager when you can.
      </p>
      <IssueTable issues={warnings} kind="warning" />
    </div>
  );
}

function fmtCount(n) {
  return n == null ? '—' : Number(n).toLocaleString();
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
          <p style={{ fontSize: 14, fontWeight: 600, color: t.head, flex: 1 }}>{title}</p>
          {search !== undefined && (
            <input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder || 'Filter…'}
              style={{ ...selectStyle, width: 200, background: '#fff' }}
            />
          )}
        </div>
        {summary && <p style={{ fontSize: 12, color: t.head, opacity: 0.75, marginTop: 2 }}>{summary}</p>}
      </div>
      {/* Cap body height so tall rollups don't dominate — the list
          scrolls inside the panel, but the panel stays compact. */}
      <div style={{ maxHeight: 520, overflowY: 'auto', overflowX: 'auto' }}>{children}</div>
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
      summary="These BM names aren't linked to a staff member. Map each one once."
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
        <div style={{ padding: 16, textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>No matches.</div>
      )}
    </RollupFrame>
  );
}

function AssigneeRow({ group, staff, isResolved, onResolved }) {
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
      // Key must be LOWER(TRIM(...)) to match the import-side lookup
      // in ingest_bm_tasks(). group.key carries the title-case display
      // form — preserve it as display_name.
      const rawName = (group.key || '').trim();
      const lowerKey = rawName.toLowerCase();
      await supabase.from('bm_staff_aliases').upsert({
        bm_assignee_name: lowerKey,
        display_name: rawName,
        staff_profile_id: pick === 'alias-only' ? null : pick,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: 'bm_assignee_name' });
      onResolved();
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
          <div style={{ fontSize: 14, color: isResolved ? '#15803d' : '#0f172a', fontWeight: 500 }}>
            {isResolved && <Check size={12} style={{ display: 'inline', marginRight: 4, color: '#15803d' }} />}
            {group.key}
          </div>
          {sampleTask && !isResolved && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>
              e.g. {sampleTask}
            </div>
          )}
        </div>
        <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>{group.count.toLocaleString()} tasks</span>
        {!isResolved && (
          <>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...selectStyle, minWidth: 190 }}>
            <option value="">Choose staff member…</option>
            {staff.filter((s) => s.is_active !== false).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <option disabled>──────────</option>
            <option value="alias-only">Record alias only (not yet in Athena)</option>
          </select>
          <button onClick={save} disabled={!pick || saving} style={{ ...BTN.primary.sm, ...btnIcon, opacity: !pick ? 0.45 : 1 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          </>
        )}
      </div>
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
      summary="Add one rule per task type. Service, lead time and duration are pre-filled; change them if needed. NST: tasks are excluded."
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
        <div style={{ padding: 16, textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>No matches.</div>
      )}
    </RollupFrame>
  );
}

const SERVICE_SUGGESTIONS = ['Accounts', 'Bookkeeping', 'VAT', 'Payroll', 'Personal Tax', 'Corporation Tax', 'Admin', 'CIS', 'Company Secretarial', 'Other'];

// Strip the period-end suffix so defaults are driven by *task type*
// alone, not by the specific quarter / year that happens to be in
// the name. "VAT Preparation Quarterly End 31/08/2024" becomes
// "VAT Preparation"; "Accounts Bookkeeping Period End 30/11/2025"
// becomes "Accounts Bookkeeping". Scheduling concerns (cadence, lead
// time) are the rule's job, not the individual task instance's.
function stripPeriodSuffix(name) {
  if (!name) return '';
  let s = String(name);
  // Trailing dd/mm/yyyy
  s = s.replace(/\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/i, '');
  // Tax year tags: "Tax Year 2025/26", "Tax Year 25/26"
  s = s.replace(/\s+tax\s*year\s*\d{2,4}\s*\/\s*\d{2,4}\s*$/i, '');
  // "Year End ...", "Quarterly End ...", "Period End ...", "Month End ..."
  s = s.replace(/\s+(?:year|quarter(?:ly)?|period|month)[\s-]*end\b.*$/i, '');
  // Lone trailing "End"
  s = s.replace(/\s+\bend\s*$/i, '');
  // Trailing "Quarterly" / "Annual" period words with no remaining context
  s = s.replace(/\s+\b(?:quarterly|annually)\s*$/i, '');
  return s.trim();
}

// Heuristic service inference from the task *type* (period stripped).
function inferService(name) {
  const n = stripPeriodSuffix(name).toLowerCase();
  if (/\bvat\b/.test(n)) return 'VAT';
  if (/payroll|p11d|rti|paye|p60|p45/.test(n)) return 'Payroll';
  if (/bookkeeping|reconcil|bank\s*rec/.test(n)) return 'Bookkeeping';
  if (/self[\s-]*assessment|personal\s*tax|\bsa\b/.test(n)) return 'Personal Tax';
  if (/corporation\s*tax|\bct600\b|\bct\s*return\b/.test(n)) return 'Corporation Tax';
  if (/\bcis\b/.test(n)) return 'CIS';
  if (/company\s*sec|confirmation\s*statement|\bps01\b/.test(n)) return 'Company Secretarial';
  if (/accounts|balance\s*sheet|p\s*\&\s*l/.test(n)) return 'Accounts';
  if (/onboard|new\s*client|setup|registration|engagement/.test(n)) return 'Admin';
  return 'Admin';
}

// Default lead time in days — driven by task type, not the date in
// the name. Annual-cycle tasks get a longer runway.
function inferLeadDays(name) {
  const n = stripPeriodSuffix(name).toLowerCase();
  if (/accounts|corporation\s*tax|self[\s-]*assessment|confirmation\s*statement|p11d/.test(n)) return 30;
  if (/\bvat\b|bookkeeping|payroll/.test(n)) return 14;
  return 14;
}

// Default standard duration in minutes — driven by task type.
// Numbers are conservative defaults; the team will tweak per rule.
function inferStandardMinutes(name) {
  const n = stripPeriodSuffix(name).toLowerCase();
  if (/\bvat\b.*prep/.test(n))          return 90;
  if (/\bvat\b.*submission/.test(n))    return 15;
  if (/\bvat\b/.test(n))                return 60;
  if (/p11d/.test(n))                   return 30;
  if (/payroll/.test(n))                return 30;
  if (/bookkeeping/.test(n))            return 60;
  if (/self[\s-]*assessment.*prep/.test(n))       return 120;
  if (/self[\s-]*assessment.*submission/.test(n)) return 15;
  if (/self[\s-]*assessment/.test(n))   return 90;
  if (/accounts.*prep/.test(n))         return 240;
  if (/year[\s-]*end/.test(n))          return 240;
  if (/accounts/.test(n))               return 180;
  if (/ct600|corporation\s*tax/.test(n))return 90;
  if (/onboard|new\s*client|setup/.test(n)) return 60;
  if (/confirmation\s*statement/.test(n))   return 15;
  return 60;
}

// Prefix default = the stripped task type itself (first-word match on
// server side, but the stripped name is the human-readable display and
// covers the common case). Team can override in the inline input.
function defaultPrefix(name) {
  const stripped = stripPeriodSuffix(name);
  if (stripped) return stripped;
  const words = (name || '').split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).join(' ') || name || '').trim();
}

function RuleRow({ group, isResolved, onResolved }) {
  const [open, setOpen] = useState(false);
  const [prefix, setPrefix] = useState(() => defaultPrefix(group.key));
  const [service, setService] = useState(() => inferService(group.key));
  const [leadDays, setLeadDays] = useState(() => inferLeadDays(group.key));
  // Duration is stored in minutes in the UI. The DB column is
  // `standard_hours` (numeric) so we divide by 60 on save.
  const [minutes, setMinutes] = useState(() => inferStandardMinutes(group.key));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await supabase.from('bm_scheduling_rules').insert({
        name: group.key.slice(0, 80),
        task_name_prefix: prefix.trim() || group.key,
        service,
        lead_time_days: Number(leadDays) || 14,
        standard_hours: (Number(minutes) || 60) / 60,
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
        <span style={{ flex: 1, fontSize: 14, color: isResolved ? '#15803d' : '#0f172a', fontWeight: 500 }}>
          {isResolved && <Check size={12} style={{ display: 'inline', marginRight: 4, color: '#15803d' }} />}
          {group.key}
        </span>
        <span style={{ fontSize: 12, color: '#64748b' }}>{group.count.toLocaleString()} tasks</span>
        {!isResolved && (
          <button onClick={() => setOpen(!open)} style={{ ...BTN.secondary.sm }}>
            {open ? 'Cancel' : 'Add rule'}
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
              <span>Std minutes</span>
              <input type="number" min={0} step={5} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={selectStyle} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button onClick={save} disabled={saving || !prefix.trim()} style={{ ...BTN.primary.sm, ...btnIcon }}>
              {saving ? 'Saving…' : 'Save rule'}
            </button>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              Assignee comes from BM. Edit later in Workflow → Rules.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function UnknownClientsPanel({ groups, onChanged }) {
  const [search, setSearch] = useState('');
  const [resolved, setResolved] = useState({}); // { [bm_ref]: 'created'|'mapped'|'ignored' }
  const [ignoredSet, setIgnoredSet] = useState(() => new Set());

  // Fetch persisted ignore list once — already-ignored refs vanish from the panel.
  useEffect(() => {
    let live = true;
    supabase
      .from('import_ignored_bm_refs')
      .select('bm_client_id')
      .then(({ data }) => {
        if (!live) return;
        setIgnoredSet(new Set((data || []).map((r) => r.bm_client_id)));
      });
    return () => { live = false; };
  }, []);

  const visibleGroups = useMemo(
    () => groups.filter((g) => !ignoredSet.has(g.key)),
    [groups, ignoredSet]
  );
  const ignoredGroups = useMemo(
    () => groups.filter((g) => ignoredSet.has(g.key)),
    [groups, ignoredSet]
  );
  const totalTasks = visibleGroups.reduce((n, g) => n + g.count, 0);
  const filtered = useFilteredGroups(visibleGroups, search);

  // An ignored reference no longer asks for a decision, but BrightManager
  // still has live tasks on it. Say so rather than hide them.
  const ignoredNote = ignoredGroups.length > 0 && (
    <div style={{ ...banner('slate'), fontSize: 13, display: 'block' }}>
      Also {ignoredGroups.reduce((n, g) => n + g.count, 0)} tasks on references you chose to ignore
      ({ignoredGroups.map((g) => `${g.key} · ${g.count}`).join(', ')}). They import without a client.
      If a client is still live in BrightManager, un-ignore it under Settings → Data import.
    </div>
  );

  if (visibleGroups.length === 0) return ignoredNote || null;
  return (
    <>
    <RollupFrame
      tone="red"
      title={`Unknown client references · ${visibleGroups.length} references, ${totalTasks.toLocaleString()} tasks`}
      summary="These BM references don't match a client. Create a prospect, map to a client, or ignore."
      search={visibleGroups.length > 8 ? search : undefined}
      onSearchChange={setSearch}
      searchPlaceholder="Filter references…"
    >
      {filtered.map((g) => (
        <UnknownClientRow
          key={g.key}
          group={g}
          resolvedState={resolved[g.key]}
          onResolved={(state) => {
            setResolved((prev) => ({ ...prev, [g.key]: state }));
            if (state === 'ignored') {
              setIgnoredSet((prev) => new Set(prev).add(g.key));
            }
          }}
          onChanged={onChanged}
        />
      ))}
      {filtered.length === 0 && (
        <div style={{ padding: 16, textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>No matches.</div>
      )}
    </RollupFrame>
    {ignoredNote}
    </>
  );
}

const ENTITY_TYPES = [
  { value: 'limited_company', label: 'Limited company' },
  { value: 'sole_trader',     label: 'Sole trader' },
  { value: 'partnership',     label: 'Partnership' },
  { value: 'llp',             label: 'LLP' },
  { value: 'personal',        label: 'Personal' },
];

function UnknownClientRow({ group, resolvedState, onResolved, onChanged }) {
  const sampleName = group.samples.find((s) => s.client_name)?.client_name || '';
  const [mode, setMode] = useState(null); // null | 'create' | 'map' | 'ignore'
  const [name, setName] = useState(sampleName);
  const [type, setType] = useState('limited_company');
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState(null); // { id, name, ... }
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const isResolved = !!resolvedState;
  const resolvedLabel = {
    created: '✓ Prospect created',
    mapped:  '✓ Mapped to existing client',
    ignored: '✓ Ignored',
  }[resolvedState];

  const submit = async () => {
    setSaving(true); setErr(null);
    try {
      if (mode === 'create') {
        const { error } = await supabase.rpc('create_prospect_for_bm_ref', {
          p_bm_client_id: group.key, p_name: name.trim(), p_type: type,
        });
        if (error) throw error;
        onResolved('created');
        if (onChanged) onChanged();
      } else if (mode === 'map') {
        if (!picked) throw new Error('Pick a client first');
        const { error } = await supabase.rpc('map_bm_ref_to_entity', {
          p_bm_client_id: group.key, p_entity_id: picked.id,
        });
        if (error) throw error;
        onResolved('mapped');
        if (onChanged) onChanged();
      } else if (mode === 'ignore') {
        const { error } = await supabase.rpc('ignore_bm_ref', {
          p_bm_client_id: group.key, p_reason: reason || null,
        });
        if (error) throw error;
        onResolved('ignored');
      }
      setMode(null);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ borderBottom: '1px solid rgba(252,165,165,0.3)', background: isResolved ? 'rgba(220,252,231,0.4)' : 'transparent' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px' }}>
        <span style={{ flex: '0 0 110px', fontSize: 14, color: '#0f172a', fontFamily: 'monospace' }}>{group.key}</span>
        <span style={{ flex: 1, fontSize: 13, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sampleName ? sampleName : <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>name not in tasks CSV</span>}
        </span>
        <span style={{ fontSize: 12, color: '#64748b' }}>{group.count.toLocaleString()} tasks</span>
        {isResolved ? (
          <span style={{ fontSize: 12, color: '#065f46', fontWeight: 600 }}>{resolvedLabel}</span>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setMode(mode === 'create' ? null : 'create')} style={{ ...BTN.secondary.sm }}>
              {mode === 'create' ? 'Cancel' : 'Create prospect'}
            </button>
            <button onClick={() => setMode(mode === 'map' ? null : 'map')} style={{ ...BTN.secondary.sm }}>
              {mode === 'map' ? 'Cancel' : 'Map to client'}
            </button>
            <button onClick={() => setMode(mode === 'ignore' ? null : 'ignore')} style={BTN.secondary.sm}>
              {mode === 'ignore' ? 'Cancel' : 'Ignore'}
            </button>
          </div>
        )}
      </div>

      {mode === 'create' && !isResolved && (
        <div style={{ padding: '10px 14px', borderTop: '1px dashed #e5e7eb', background: '#fff' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, alignItems: 'end' }}>
            <label style={miniLabel}>
              <span>Client name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} style={selectStyle} placeholder="e.g. Acme Holdings Ltd" />
            </label>
            <label style={miniLabel}>
              <span>Client type</span>
              <select value={type} onChange={(e) => setType(e.target.value)} style={selectStyle}>
                {ENTITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button onClick={submit} disabled={saving || !name.trim()} style={{ ...BTN.primary.sm, ...btnIcon }}>
              {saving ? 'Creating…' : 'Create prospect'}
            </button>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              Created as a prospect, linked to BM ID <strong>{group.key}</strong>.
            </span>
          </div>
          {err && <p style={{ fontSize: 12, color: '#991b1b', marginTop: 6 }}>{err}</p>}
        </div>
      )}

      {mode === 'map' && !isResolved && (
        <div style={{ padding: '10px 14px', borderTop: '1px dashed #e5e7eb', background: '#fff' }}>
          <EntityPicker value={picked} onChange={setPicked} initialQuery={sampleName} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button onClick={submit} disabled={saving || !picked} style={{ ...BTN.primary.sm, ...btnIcon }}>
              {saving ? 'Mapping…' : picked ? `Map to "${picked.name}"` : 'Pick a client'}
            </button>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              Links BM ID <strong>{group.key}</strong> to this client. Fails if another client already has it.
            </span>
          </div>
          {err && <p style={{ fontSize: 12, color: '#991b1b', marginTop: 6 }}>{err}</p>}
        </div>
      )}

      {mode === 'ignore' && !isResolved && (
        <div style={{ padding: '10px 14px', borderTop: '1px dashed #e5e7eb', background: '#fff' }}>
          <label style={miniLabel}>
            <span>Reason (optional)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} style={selectStyle} placeholder="e.g. dormant in BM, never engaged" />
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button onClick={submit} disabled={saving} style={{ ...BTN.primary.sm, ...btnIcon }}>
              {saving ? 'Saving…' : 'Ignore this reference'}
            </button>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              {group.key} will be hidden from this panel on future imports. Tasks with this reference still import unattached. Unignore from Settings → Data import → Settings.
            </span>
          </div>
          {err && <p style={{ fontSize: 12, color: '#991b1b', marginTop: 6 }}>{err}</p>}
        </div>
      )}
    </div>
  );
}

// Parse `duplicate bm_client_id CLA001 used by multiple rows in this upload ("Castle Letting Agency", "Clarkson, Greg") — …`
// into { names: [string] }. Returns null if the reason is something else.
function parseDupBmRefReason(reason) {
  if (typeof reason !== 'string') return null;
  if (!/^duplicate bm_client_id /i.test(reason)) return null;
  const namesPart = reason.match(/\(([^)]+)\)/);
  const names = namesPart ? namesPart[1].split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1')) : [];
  return { names };
}

function DuplicateBmRefPanel({ skipped }) {
  const rows = useMemo(() => {
    return (skipped || []).map((s) => {
      const parsed = parseDupBmRefReason(s.reason);
      if (!parsed) return null;
      return { bm_client_id: s.bm_client_id, names: parsed.names };
    }).filter(Boolean);
  }, [skipped]);

  // Deduplicate — every skipped row in the colliding set has the same bm_client_id.
  const grouped = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.bm_client_id)) map.set(r.bm_client_id, r);
    }
    return [...map.values()];
  }, [rows]);

  if (grouped.length === 0) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>
        Needs attention · duplicate Internal References
      </p>
      <RollupFrame
        tone="red"
        title={`Duplicate Internal References · ${grouped.length} ${grouped.length === 1 ? 'reference' : 'references'}`}
        summary="These clients share an Internal Reference, so all were skipped. Give each its own reference in BrightManager and re-import."
      >
        {grouped.map((r) => (
          <div key={r.bm_client_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid rgba(252,165,165,0.3)' }}>
            <span style={{ flex: '0 0 110px', fontSize: 14, color: '#0f172a', fontFamily: 'monospace' }}>{r.bm_client_id}</span>
            <span style={{ flex: 1, fontSize: 13, color: '#475569' }}>
              {r.names.length > 0 ? `Used by: ${r.names.join(' · ')}` : 'Multiple rows in this upload share this reference.'}
            </span>
          </div>
        ))}
      </RollupFrame>
    </div>
  );
}

// The RPC builds `warnings` by appending `{ duplicate_names: {...} }` to an
// empty jsonb array, so it lands as `[{ duplicate_names: {...} }]`. Tolerate
// both shapes (array element or top-level key) for forward-compat.
function extractWarning(warnings, key) {
  if (!warnings) return null;
  if (Array.isArray(warnings)) {
    for (const w of warnings) {
      if (w && w[key]) return w[key];
    }
    return null;
  }
  return warnings[key] || null;
}

function DuplicateNamePanel({ duplicateNames }) {
  if (!duplicateNames || typeof duplicateNames !== 'object') return null;
  const entries = Object.entries(duplicateNames);
  if (entries.length === 0) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>
        Heads-up · same client name on multiple references
      </p>
      <RollupFrame
        tone="amber"
        title={`Same name, different BM ID · ${entries.length} ${entries.length === 1 ? 'name' : 'names'}`}
        summary="These imported normally. Check whether they are different people with the same name or one client entered twice in BM."
      >
        {entries.map(([name, bmIds]) => (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid rgba(252,211,77,0.4)' }}>
            <span style={{ flex: 1, fontSize: 14, color: '#0f172a' }}>{name}</span>
            <span style={{ fontSize: 12, color: '#475569', fontFamily: 'monospace' }}>
              {Array.isArray(bmIds) ? bmIds.join(' · ') : String(bmIds)}
            </span>
          </div>
        ))}
      </RollupFrame>
    </div>
  );
}

// Parse `duplicate company_number SC123456 already on bm_client_id BIGH002`
// into { company_number, existing_bm_client_id }. Returns null if the reason
// is something else.
function parseDupCompanyReason(reason) {
  if (typeof reason !== 'string') return null;
  const m = reason.match(/^duplicate company_number (\S+) already on bm_client_id (\S+)/i);
  if (!m) return null;
  return { company_number: m[1], existing_bm_client_id: m[2] };
}

function DuplicateCompanyPanel({ skipped }) {
  const rows = useMemo(() => {
    return (skipped || []).map((s) => {
      const parsed = parseDupCompanyReason(s.reason);
      if (!parsed) return null;
      return {
        incoming_bm_client_id: s.bm_client_id,
        company_number: parsed.company_number,
        existing_bm_client_id: parsed.existing_bm_client_id,
      };
    }).filter(Boolean);
  }, [skipped]);

  if (rows.length === 0) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>
        Needs attention · duplicate company numbers
      </p>
      <RollupFrame
        tone="amber"
        title={`Duplicate company numbers · ${rows.length} ${rows.length === 1 ? 'collision' : 'collisions'}`}
        summary="This company number already belongs to another client. Clear it from that client, or ignore this row."
      >
        {rows.map((r) => <DuplicateCompanyRow key={r.incoming_bm_client_id} row={r} />)}
      </RollupFrame>
    </div>
  );
}

function DuplicateCompanyRow({ row }) {
  const [existing, setExisting] = useState(null);
  const [loading, setLoading] = useState(true);
  const [resolved, setResolved] = useState(null); // 'cleared' | 'ignored'
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    supabase
      .from('entities')
      .select('id, name, bm_client_id, company_number, entity_status, source')
      .eq('company_number', row.company_number)
      .limit(1)
      .then(({ data }) => {
        if (!live) return;
        setExisting((data || [])[0] || null);
        setLoading(false);
      });
    return () => { live = false; };
  }, [row.company_number]);

  const clearCompany = async () => {
    if (!existing) return;
    setSaving(true); setErr(null);
    const { error } = await supabase.rpc('clear_company_number_on_entity', { p_entity_id: existing.id });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setResolved('cleared');
  };

  const ignoreRef = async () => {
    setSaving(true); setErr(null);
    const { error } = await supabase.rpc('ignore_bm_ref', {
      p_bm_client_id: row.incoming_bm_client_id,
      p_reason: `duplicate company_number with ${row.existing_bm_client_id}`,
    });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setResolved('ignored');
  };

  return (
    <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(252,211,77,0.4)', background: resolved ? 'rgba(220,252,231,0.4)' : 'transparent' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8' }}>
            Incoming BM row
          </p>
          <p style={{ fontSize: 14, color: '#0f172a', fontFamily: 'monospace' }}>{row.incoming_bm_client_id}</p>
          <p style={{ fontSize: 13, color: '#475569' }}>Company number <strong>{row.company_number}</strong></p>
        </div>
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8' }}>
            Existing client
          </p>
          {loading && <p style={{ fontSize: 13, color: '#94a3b8' }}>Looking up…</p>}
          {!loading && !existing && <p style={{ fontSize: 13, color: '#94a3b8' }}>Client not found (changed since the import?)</p>}
          {existing && (
            <>
              <p style={{ fontSize: 14, color: '#0f172a' }}>{existing.name}</p>
              <p style={{ fontSize: 13, color: '#475569' }}>
                BM ID <strong>{existing.bm_client_id || '—'}</strong> · status <strong>{existing.entity_status}</strong>
              </p>
            </>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
        {resolved === 'cleared' && (
          <span style={{ fontSize: 12, color: '#065f46', fontWeight: 600 }}>
            ✓ Company number cleared. Re-run the BM clients import to attach it to {row.incoming_bm_client_id}
          </span>
        )}
        {resolved === 'ignored' && (
          <span style={{ fontSize: 12, color: '#065f46', fontWeight: 600 }}>
            ✓ Incoming BM ID ignored on future imports
          </span>
        )}
        {!resolved && (
          <>
            <button onClick={clearCompany} disabled={saving || !existing} style={{ ...BTN.secondary.sm }}>
              {saving ? 'Working…' : `Clear ${row.company_number} from existing`}
            </button>
            <button onClick={ignoreRef} disabled={saving} style={BTN.secondary.sm}>
              Ignore {row.incoming_bm_client_id}
            </button>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              Clear if the incoming BM row is right; ignore if it is wrong.
            </span>
          </>
        )}
      </div>
      {err && <p style={{ fontSize: 12, color: '#991b1b', marginTop: 6 }}>{err}</p>}
    </div>
  );
}

function EntityPicker({ value, onChange, initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    const handle = setTimeout(async () => {
      const { data } = await supabase.rpc('search_entities_for_wizard', { p_query: query, p_limit: 12 });
      if (!live) return;
      setResults(data || []);
      setLoading(false);
    }, 200);
    return () => { live = false; clearTimeout(handle); };
  }, [query]);

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, BM ID, or company number…"
        style={{ ...selectStyle, width: '100%' }}
        autoFocus
      />
      <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 6, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }}>
        {loading && results.length === 0 && (
          <div style={{ padding: 10, fontSize: 12, color: '#94a3b8' }}>Searching…</div>
        )}
        {!loading && results.length === 0 && (
          <div style={{ padding: 10, fontSize: 12, color: '#94a3b8' }}>No matches.</div>
        )}
        {results.map((r) => {
          const selected = value?.id === r.id;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onChange(r)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                textAlign: 'left', padding: '6px 10px', background: selected ? '#eff6ff' : '#fff',
                border: 'none', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', fontFamily: font,
              }}
            >
              <span style={{ flex: 1, fontSize: 13, color: '#0f172a' }}>{r.name}</span>
              <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>{r.bm_client_id || '—'}</span>
              <span style={{ fontSize: 11, color: '#64748b' }}>{r.company_number || ''}</span>
              <span style={{ fontSize: 11, color: r.entity_status === 'prospect' ? '#92400e' : '#475569', textTransform: 'capitalize' }}>{r.entity_status}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const miniLabel = {
  display: 'flex', flexDirection: 'column', gap: 3,
  fontSize: 11, fontWeight: 600, color: '#94a3b8',
  };

function rollupRowStyle(done) {
  return {
    borderBottom: '1px solid rgba(252,211,77,0.4)',
    background: done ? 'rgba(220,252,231,0.4)' : 'transparent',
  };
}

const selectStyle = {
  fontSize: 13, padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 6,
  background: '#fff', color: '#1e293b', outline: 'none', fontFamily: font,
};

function IssueTable({ issues, kind }) {
  const [limit, setLimit] = useState(50);
  const shown = issues.slice(0, limit);
  const fieldColor = kind === 'skipped' ? '#991b1b' : '#b45309';
  return (
    <div style={{ paddingLeft: 8, paddingRight: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: font }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={ithRow}>Row</th>
            <th style={ithRow}>Reference</th>
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
        <button onClick={() => setLimit(limit + 100)} style={{ ...BTN.secondary.sm, marginTop: 8 }}>
          Show {Math.min(100, issues.length - limit)} more of {issues.length - limit}
        </button>
      )}
    </div>
  );
}

/* ─── Archive candidates ──────────────────────────────────────
   Active BrightManager clients that aren't in this upload — i.e.
   they've been archived/removed in BM since the last export. Every
   candidate is ticked by default (will be archived on approve); the
   user unticks any they want to keep active. A loud warning fires
   when the count looks like a partial/filtered export rather than a
   genuine handful of departures, so nobody mass-archives by accident.
   ─────────────────────────────────────────────────────────── */
// Which agent-authorisation columns this export carried. Reported either way:
// finding none is the more useful answer, because it explains why Onboarding →
// Cross-check still shows "no data" in the BrightManager column.
function AgentColumnsPanel({ columns }) {
  const TAX_NAMES = { sa: 'Self Assessment', ct: 'Corporation Tax', vat: 'VAT', paye: 'PAYE', cis: 'CIS' };
  const found = columns && columns.length > 0;
  return (
    <div style={{
      background: '#fff', border: `1px solid ${found ? '#86efac' : '#fcd34d'}`,
      borderRadius: 12, padding: '14px 18px', marginTop: 14,
    }}>
      <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>
        Agent authorisation columns — {found ? `${columns.length} found` : 'none found'}
      </div>
      {found ? (
        <>
          <div style={{ fontSize: 13.5, color: '#475569', marginBottom: 10, lineHeight: 1.5 }}>
            These will be read into each client&apos;s record and drive the BrightManager column on
            Onboarding → Cross-check. A tax not listed here keeps whatever it already had, rather than
            being set to &quot;not authorised&quot;.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {columns.map((c) => (
              <span key={c.tax} style={{
                fontSize: 13.5, padding: '5px 10px', borderRadius: 8,
                border: '1px solid #e5e7eb', background: '#f8fafc', color: '#334155',
              }}>
                <strong>{TAX_NAMES[c.tax] || c.tax}</strong> ← &ldquo;{c.header}&rdquo;
              </span>
            ))}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13.5, color: '#92400e', lineHeight: 1.5 }}>
          No column in this file names both an authorisation and a tax, so nothing about &quot;are we the
          agent&quot; will be imported and Onboarding → Cross-check will keep reading &quot;no data&quot;
          for BrightManager. If BM does export those fields, re-export with them included — the columns
          are matched on wording, so no code change is needed.
        </div>
      )}
    </div>
  );
}

// What the upload says about PEOPLE, as against clients. BM's export carries
// two reference fields — "Internal Reference" for the client and "Person
// Internal Reference" for the contact — and until now Athena read only the
// first, so one human who is the contact for eight clients became eight
// people. This panel is how you see the difference before approving.
function PeoplePanel({ summary, rowCount }) {
  if (!summary) return null;
  const {
    distinct_refs: refs,
    distinct_people: people,
    secondary_contacts: secondary,
    rows_without_a_person_ref: missing,
  } = summary;

  if (!refs) {
    return (
      <div style={{
        background: '#fff', border: '1px solid #fcd34d', borderRadius: 12,
        padding: '14px 18px', marginTop: 14,
      }}>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>
          Person references — none found
        </div>
        <div style={{ fontSize: 13.5, color: '#92400e', lineHeight: 1.5 }}>
          This export has no &quot;Person Internal Reference&quot; column, so contacts can&apos;t be
          identified across clients. Athena falls back to the old behaviour: one person record per
          client, meaning the same human appears once for every client they act for. Re-export from
          BrightManager with the person columns included to fix it — no code change needed.
        </div>
      </div>
    );
  }

  const Stat = ({ label, value, note }) => (
    <div style={{ minWidth: 130 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 13, color: '#334155', fontWeight: 600 }}>{label}</div>
      {note ? <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{note}</div> : null}
    </div>
  );

  return (
    <div style={{
      background: '#fff', border: '1px solid #86efac', borderRadius: 12,
      padding: '14px 18px', marginTop: 14,
    }}>
      <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0f172a', marginBottom: 10 }}>
        People in this upload
      </div>
      <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', marginBottom: 10 }}>
        <Stat label="Client rows" value={rowCount} />
        <Stat label="Person references" value={refs} note="BrightManager's person codes" />
        <Stat
          label="Distinct people"
          value={people}
          note={people > refs ? `${people - refs} reference${people - refs === 1 ? '' : 's'} split by date of birth` : 'one person per reference'}
        />
        <Stat label="Secondary contacts" value={secondary} note="previously not imported at all" />
      </div>
      <div style={{ fontSize: 13.5, color: '#475569', lineHeight: 1.5 }}>
        People are matched on reference <em>and</em> date of birth. Nothing is merged; possible
        duplicates are sent for review.
        {missing > 0 ? (
          <>
            {' '}
            <strong>{missing}</strong> row{missing === 1 ? '' : 's'} carry no person reference, so
            their contact can only be recorded against that one client.
          </>
        ) : null}
      </div>
    </div>
  );
}

// One Person Internal Reference, two different people. A BrightManager data
// fix, not an Athena one — it will keep colliding on every re-import until
// the second person gets their own reference there.
function PersonRefCollisionPanel({ collisions }) {
  if (!collisions || collisions.length === 0) return null;
  return (
    <div>
      <RollupFrame
        tone="amber"
        title={`Shared Person Internal Reference · ${collisions.length} ${collisions.length === 1 ? 'reference' : 'references'}`}
        summary="Two people share one person reference in BrightManager. They import as separate people, so nothing is blocked. Give the second person their own reference in BM. Each one goes on the admin task list until it is fixed."
      >
        {collisions.map((c) => (
          <div key={c.person_ref} style={{ padding: '8px 14px', borderBottom: '1px solid rgba(252,211,77,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ flex: '0 0 110px', fontSize: 14, color: '#0f172a', fontFamily: 'monospace' }}>
                {c.person_ref}
              </span>
              <span style={{ flex: 1, fontSize: 13, color: '#475569' }}>
                {c.people.map((p) => (
                  <span key={`${p.name}-${p.dob || ''}`} style={{ marginRight: 14 }}>
                    <strong style={{ color: '#0f172a' }}>{p.name}</strong>
                    {p.dob ? ` · b. ${p.dob}` : ' · no date of birth'}
                  </span>
                ))}
              </span>
            </div>
          </div>
        ))}
      </RollupFrame>
    </div>
  );
}

// Clients that look missing but are in the upload under a new Internal
// Reference. Ticked ones are moved to the new reference on approve, so the
// import updates the existing client (history, fees, tasks and all) instead of
// archiving it and failing to import its replacement.
function RefChangesPanel({ changes, selection, setSelection }) {
  const setOne = (ref, val) => setSelection((s) => ({ ...s, [ref]: val }));
  const ticked = changes.filter((c) => selection[c.old_bm_client_id]).length;
  return (
    <div style={{
      background: '#fff', border: '1px solid #93c5fd', borderRadius: 10,
      padding: 16, marginBottom: 16, marginTop: 14,
    }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>
        Reference changed in BrightManager — {changes.length}
      </p>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 10 }}>
        These clients are in this export under a new Internal Reference. Ticked ones move to the new
        reference when you approve, so the existing client is updated instead of archived.
      </p>
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
        {changes.map((c) => {
          const checked = !!selection[c.old_bm_client_id];
          const byNumber = c.match === 'company_number';
          return (
            <label key={c.old_bm_client_id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              borderBottom: '1px solid #f1f5f9', cursor: 'pointer',
            }}>
              <input type="checkbox" checked={checked} onChange={(e) => setOne(c.old_bm_client_id, e.target.checked)} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 14, color: '#0f172a' }}>{c.name}</span>
                {c.new_name && c.new_name !== c.name && (
                  <span style={{ fontSize: 12.5, color: '#64748b' }}> · BM now calls it {c.new_name}</span>
                )}
                <span style={{ display: 'block', fontSize: 12, color: '#64748b' }}>
                  {byNumber ? `Same company number ${c.company_number}` : 'Same name, no company number — check it is the same client'}
                </span>
              </span>
              <span style={{ fontSize: 12.5, color: '#475569', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                {c.old_bm_client_id} → {c.new_bm_client_id}
              </span>
            </label>
          );
        })}
      </div>
      <p style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>
        {ticked} of {changes.length} will move. An unticked company-number match is left as it is and goes on
        the admin task list; an unticked name match is treated as a different client.
      </p>
    </div>
  );
}

function ArchiveCandidatesPanel({ candidates, presentCount, selection, setSelection }) {
  const selectedCount = candidates.filter((c) => selection[c.bm_client_id]).length;

  // Heuristic: if we'd archive a big slice of the book, the upload was
  // probably filtered (not the full active-client list). Warn loudly.
  const ratio = presentCount > 0 ? candidates.length / presentCount : 0;
  const looksPartial = candidates.length > 40 || ratio > 0.2;

  const setOne = (bmId, val) =>
    setSelection((s) => ({ ...s, [bmId]: val }));
  const setAll = (val) =>
    setSelection(Object.fromEntries(candidates.map((c) => [c.bm_client_id, val])));

  const fmtDate = (d) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch { return '—'; }
  };

  return (
    <div style={{
      background: looksPartial ? '#fef2f2' : '#fff',
      border: `1px solid ${looksPartial ? '#fca5a5' : '#e5e7eb'}`,
      borderRadius: 10, padding: 16, marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <p style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>
          Clients no longer in BrightManager — {candidates.length}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setAll(true)} style={BTN.secondary.sm}>Select all</button>
          <button onClick={() => setAll(false)} style={BTN.secondary.sm}>Deselect all</button>
        </div>
      </div>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 10 }}>
        These active clients aren't in this export, so they look archived in BrightManager.
        Ticked ones will be set to <strong>archived</strong> when you approve. Untick any you want to keep active.
      </p>

      {looksPartial && (
        <div style={{ ...banner('red'), marginBottom: 10 }}>
          <AlertTriangle size={14} style={{ color: '#991b1b', flexShrink: 0 }} />
          <span>
            That's {candidates.length} of {presentCount + candidates.length} clients — a large share.
            If this export was filtered (not your full active-client list), <strong>deselect all</strong> before
            approving, or these will be archived in error.
          </span>
        </div>
      )}

      <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
        {candidates.map((c) => {
          const checked = !!selection[c.bm_client_id];
          return (
            <label key={c.bm_client_id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px',
              borderBottom: '1px solid #f1f5f9', cursor: 'pointer',
              background: checked ? 'transparent' : '#f8fafc',
            }}>
              <input type="checkbox" checked={checked} onChange={(e) => setOne(c.bm_client_id, e.target.checked)} />
              <span style={{ flex: 1, fontSize: 14, color: checked ? '#0f172a' : '#94a3b8' }}>
                {c.name}
              </span>
              <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>{c.bm_client_id}</span>
              <span style={{ fontSize: 12, color: '#94a3b8', width: 96, textAlign: 'right' }}>
                last seen {fmtDate(c.updated_at)}
              </span>
            </label>
          );
        })}
      </div>

      <p style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>
        {selectedCount} of {candidates.length} will be archived · {candidates.length - selectedCount} kept active.
        Archiving is reversible — flip status back on the client record if needed.
      </p>
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
      background: '#fff', border: '1px solid #fcd34d',
      borderRadius: 10, padding: 16, marginBottom: 16,
    }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>
        Possible prospect matches — {totalMembers}
      </p>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
        These BrightManager clients look like prospects already in Athena. Convert one and the prospect
        becomes that client; keep them separate and the BM client imports as a new record.
      </p>

      {contestedGroups.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: '#78350f', marginBottom: 6 }}>
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
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
                    Prospect: {g.prospect_name}
                  </span>
                  <span style={{ flex: 1 }} />
                  {chosen ? (
                    <button onClick={() => clearGroup(g)} style={BTN.secondary.sm}>Clear</button>
                  ) : (
                    <button onClick={() => rejectAllInGroup(g)} style={BTN.secondary.sm}>
                      None of these — keep the prospect
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
                      <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#78350f', width: 90 }}>{m.bm_client_id}</span>
                      <span style={{ flex: 1, fontSize: 13, color: '#1e293b' }}>
                        {m.bm_name || '—'}
                        <span style={{ color: '#94a3b8', marginLeft: 6 }}>
                          · {matchLabel(m)}
                        </span>
                      </span>
                    </label>
                  );
                })}
                <p style={{ fontSize: 12, color: '#92400e', marginTop: 6 }}>
                  The others in this group become new clients.
                </p>
              </div>
            );
          })}
        </div>
      )}

      {simpleGroups.length > 0 && (
        <div>
          <p style={{ fontSize: 12, fontWeight: 600, color: '#78350f', marginBottom: 6 }}>
            Check each match
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
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#78350f', width: 90 }}>{m.bm_client_id}</span>
                <div style={{ flex: 1, fontSize: 13, color: '#1e293b', lineHeight: 1.4 }}>
                  <div><span style={{ color: '#64748b' }}>BrightManager:</span> {m.bm_name || '—'}</div>
                  <div><span style={{ color: '#64748b' }}>Athena prospect:</span> {m.prospect_name}</div>
                  <div style={{ fontSize: 12, color: tier === 3 ? '#b45309' : '#64748b' }}>{matchLabel(m)}</div>
                </div>
                {(confirmed || (!decided && preConfirmed)) && (
                  <span style={{ fontSize: 12.5, color: '#15803d', fontWeight: 600 }}>✓ Will convert</span>
                )}
                {rejected && <span style={{ fontSize: 12.5, color: '#475569', fontWeight: 600 }}>Kept separate</span>}
                {!decided && !preConfirmed && (
                  <>
                    <button onClick={() => setOne(m.bm_client_id, m.prospect_id)} style={BTN.secondary.sm}>Convert prospect</button>
                    <button onClick={() => setOne(m.bm_client_id, 'reject')} style={BTN.secondary.sm}>Keep separate</button>
                  </>
                )}
                {(decided || preConfirmed) && (
                  <button onClick={() => {
                    if (rejected) setOne(m.bm_client_id, m.prospect_id);
                    else setOne(m.bm_client_id, 'reject');
                  }} style={BTN.secondary.sm}>
                    {rejected ? 'Convert instead' : 'Keep separate instead'}
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

function matchLabel(m) {
  if (m.tier === 1) return 'Same company number';
  if (m.tier === 2) return 'Same BrightManager reference';
  return `Name only, ${Math.round((m.score || 0) * 100)}% similar. Check it is the same business`;
}

/* ─── Task-type exclusions ────────────────────────────────────
   Lets the user toggle off task-type prefixes they never want to
   import (e.g. Payroll, Confirmation Statement). Checkboxes persist
   to app_settings so the same prefixes stay excluded on future
   imports. Unchecked = excluded.
   ─────────────────────────────────────────────────────────── */
function TaskTypeExclusionsPanel({ parsedRows, catalogue, excluded, onToggle }) {
  // Bucket parsed rows by catalogue prefix (first match). Skip NST
  // rows — they're routed to quick_tasks separately, not controllable here.
  const buckets = React.useMemo(() => {
    const counts = new Map();
    let other = 0;
    let nst = 0;
    for (const r of parsedRows) {
      const name = r.bm_task_name || '';
      if (isNstTask(name)) { nst++; continue; }
      const hit = catalogue.find((c) => name.startsWith(c.prefix));
      if (hit) counts.set(hit.prefix, (counts.get(hit.prefix) || 0) + 1);
      else other++;
    }
    const out = catalogue
      .map((c) => ({ ...c, count: counts.get(c.prefix) || 0 }))
      .filter((c) => c.count > 0)
      .sort((a, b) => a.label.localeCompare(b.label));
    return { rows: out, other, nst };
  }, [parsedRows, catalogue]);

  if (buckets.rows.length === 0 && buckets.other === 0) return null;

  const totalExcluded = buckets.rows.filter((b) => excluded.includes(b.prefix)).reduce((s, b) => s + b.count, 0);

  return (
    <div style={{
      marginTop: 18, padding: 18,
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <h3 style={{ fontSize: 14.5, fontWeight: 600, color: '#0f172a', marginBottom: 2 }}>Task types to import</h3>
          <p style={{ fontSize: 13, color: '#64748b' }}>
            Uncheck any type you never want in Athena. Your choices are remembered and pre-applied next time.
          </p>
        </div>
        {totalExcluded > 0 && (
          <span style={{ fontSize: 13, color: '#b45309', fontWeight: 600 }}>
            {totalExcluded} row{totalExcluded === 1 ? '' : 's'} will be excluded
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
        {buckets.rows.map((b) => {
          const isExcluded = excluded.includes(b.prefix);
          return (
            <label key={b.prefix} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
              background: isExcluded ? '#fef2f2' : '#f8fafc',
              border: `1px solid ${isExcluded ? '#fecaca' : '#e5e7eb'}`,
              opacity: isExcluded ? 0.8 : 1,
            }}>
              <input
                type="checkbox"
                checked={!isExcluded}
                onChange={() => onToggle(b.prefix)}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: isExcluded ? '#991b1b' : '#0f172a', textDecoration: isExcluded ? 'line-through' : 'none' }}>
                  {b.label}
                </div>
                <div style={{ fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>
                  {b.prefix} — {b.count} row{b.count === 1 ? '' : 's'}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {(buckets.other > 0 || buckets.nst > 0) && (
        <div style={{ marginTop: 10, fontSize: 12, color: '#94a3b8' }}>
          {buckets.other > 0 && <span>{buckets.other} row{buckets.other === 1 ? '' : 's'} don't match any rule — always imported. </span>}
          {buckets.nst > 0 && <span>{buckets.nst} NST row{buckets.nst === 1 ? '' : 's'} routed to quick tasks.</span>}
        </div>
      )}
    </div>
  );
}

function ProgressView({ noun, count }) {
  return (
    <div style={{
      padding: 20, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <Loader2 size={18} className="animate-spin" style={{ color: brand.solid, flexShrink: 0 }} />
      <div>
        <p style={{ fontSize: 14.5, fontWeight: 600, color: '#0f172a' }}>
          Importing {Number(count).toLocaleString()} {noun}…
        </p>
        <p style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
          This takes up to a minute. Keep this tab open until it finishes.
        </p>
      </div>
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
      <p style={{ fontSize: 14.5, fontWeight: 600, color: '#065f46', marginBottom: 4 }}>
        Import {hasRealWrite ? 'complete' : 'logged'}.
      </p>
      <p style={{ fontSize: 13, color: '#047857', marginBottom: 14 }}>
        Run ID: <code style={{ fontSize: 12 }}>{run.id}</code>
      </p>
      {hasRealWrite && source.key === 'bm_clients' ? (
        <>
          <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>Clients written</span><span style={resultNum}>{wr.entities_written.toLocaleString()}</span></div>
          <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>Prospects converted</span><span style={resultNum}>{wr.prospects_converted.toLocaleString()}</span></div>
          {wr.rekeyed > 0 && (
            <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>Moved to new BM reference</span><span style={resultNum}>{wr.rekeyed.toLocaleString()}</span></div>
          )}
          {wr.rekey_refused?.length > 0 && (
            <div style={{ fontSize: 12.5, color: '#991b1b', padding: '3px 0 3px 24px' }}>
              Not moved, because the new reference was already taken: {wr.rekey_refused.map((p) => `${p.old} → ${p.new}`).join(', ')}
            </div>
          )}
          {wr.archived > 0 && (
            <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>Clients archived (no longer in BM)</span><span style={resultNum}>{wr.archived.toLocaleString()}</span></div>
          )}
          {wr.orphans_adopted > 0 && (
            <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>Orphan records adopted</span><span style={resultNum}>{wr.orphans_adopted.toLocaleString()}</span></div>
          )}
          {wr.tidy_ups?.raised > 0 && (
            <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>Tidy-ups added to admin tasks</span><span style={resultNum}>{wr.tidy_ups.raised.toLocaleString()}</span></div>
          )}
          {wr.tidy_ups?.closed > 0 && (
            <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>Tidy-ups fixed at source</span><span style={resultNum}>{wr.tidy_ups.closed.toLocaleString()}</span></div>
          )}
          {(wr.tidy_ups?.raised > 0 || wr.tidy_ups?.closed > 0) && (
            <p style={{ fontSize: 12.5, color: '#047857', marginTop: 2, marginBottom: 8, paddingLeft: 18 }}>
              On the admin task list under <strong>BM Data Errors</strong>. Each one closes itself
              once an import stops reporting it, so fixing it in BrightManager is the whole job.
            </p>
          )}
          <DuplicateBmRefPanel skipped={wr.skipped || []} />
          <DuplicateCompanyPanel skipped={wr.skipped || []} />
          <DuplicateNamePanel duplicateNames={extractWarning(wr.warnings, 'duplicate_names')} />
          {wr.errors?.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#991b1b' }}>
                Row-level errors ({wr.errors.length})
              </summary>
              <div style={{ fontSize: 12, color: '#991b1b', paddingLeft: 14, paddingTop: 6 }}>
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
          {(wr.nst_upserted > 0 || wr.nst_removed > 0) && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #a7f3d0' }}>
              {wr.nst_upserted > 0 && (
                <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>NST tasks → quick tasks</span><span style={resultNum}>{wr.nst_upserted.toLocaleString()}</span></div>
              )}
              {wr.nst_removed > 0 && (
                <div style={resultRow}><Check size={12} style={{ color: '#15803d' }} /><span style={{ width: 180, color: '#065f46' }}>NST quick tasks removed</span><span style={resultNum}>{wr.nst_removed.toLocaleString()}</span></div>
              )}
            </div>
          )}
          {wr.flags && (
            <div style={{ marginTop: 10, padding: 10, background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8 }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: '#78350f', marginBottom: 6 }}>
                Reconciliation flags raised
              </p>
              {Object.entries(wr.flags).filter(([, n]) => n > 0).length === 0 ? (
                <p style={{ fontSize: 13, color: '#92400e' }}>None — clean import.</p>
              ) : Object.entries(wr.flags).filter(([, n]) => n > 0).map(([k, n]) => (
                <div key={k} style={{ fontSize: 13, color: '#78350f', padding: '2px 0' }}>
                  • <code style={{ fontSize: 12 }}>{k}</code>: <b>{n}</b>
                </div>
              ))}
            </div>
          )}
          {wr.errors?.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#991b1b' }}>
                Row-level errors ({wr.errors.length})
              </summary>
              <div style={{ fontSize: 12, color: '#991b1b', paddingLeft: 14, paddingTop: 6 }}>
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
        <button onClick={onGoStatus} style={{ ...BTN.primary.md, ...btnIcon }}>Back to Status</button>
        <button onClick={onPickAnother} style={BTN.secondary.md}>Pick another source</button>
        {touchesEntities && hasRealWrite && wr.entities_written > 0 && (
          <button onClick={onViewClients} style={BTN.secondary.md}>View clients</button>
        )}
        <button onClick={onGoHistory} style={BTN.secondary.md}>View in History</button>
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
function StatCell({ label, value, tone }) {
  const color = tone === 'amber' ? '#b45309' : tone === 'red' ? '#b91c1c' : '#0f172a';
  return (
    <div style={{ padding: '14px 18px', borderRight: '1px solid #e5e7eb' }}>
      <p style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 20, fontWeight: 600, color }}>{value}</p>
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
    color: t.color, fontSize: 14, marginBottom: 14,
  };
}

// Layout only; the look comes from BTN.
const btnIcon = { display: 'inline-flex', alignItems: 'center', gap: 4 };
const convRow = {
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
  padding: '10px 4px', borderTop: '1px solid #f1f5f9',
};
const resultRow = { display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, padding: '3px 0' };
const resultNum = { color: '#065f46', fontFamily: 'monospace' };
const ithRow = { textAlign: 'left', padding: '6px 8px', fontSize: 11, fontWeight: 600, color: '#94a3b8' };
const itdRow = { padding: '6px 8px', fontSize: 13, verticalAlign: 'top' };
