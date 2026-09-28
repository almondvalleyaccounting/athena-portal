import React, { useEffect, useState } from 'react';
import { chipStyle, tones } from '../../../lib/tokens';
import { BTN } from '../../../lib/buttonStyles';
import { fetchPersonMergeReview, applyPersonMerges, setPersonMergeVerdict } from '../lib/writers/bmClients';

const font = "'Outfit', sans-serif";

/*
  Possible duplicate people — the review queue the BM import writes to
  (bm_person_merge_review, sql/255). The import never merges anyone itself:
  when one BM person (reference + date of birth) matches two Athena person
  rows, it proposes a merge here. Until this tab existed nothing read the
  queue, so proposals sat unapplied and a director's Companies House record
  (roles, chase) stayed split from their BM record (reference, DOB, phone).

  One decision per row, deliberately — no "merge all". Merging repoints
  every chase, link and task onto the survivor (merge_person) and deletes
  the other row; it is not undone by a button.
*/

const fmtDob = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'no DOB');
const splitEntities = (s) => [...new Set((s || '').split(' - ').map((x) => x.trim()).filter(Boolean))];

function Side({ label, name, dob, code, entities }) {
  return (
    <div style={{ flex: '1 1 240px', minWidth: 0 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.4, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14.5, fontWeight: 600, color: '#0f172a', marginTop: 2 }}>{name || '—'}</div>
      <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 2 }}>
        {fmtDob(dob)}{code ? ` · code ${code}` : ''}
      </div>
      <div style={{ fontSize: 12.5, color: '#475569', marginTop: 4 }}>
        {entities.length ? entities.join(', ') : 'No client links'}
      </div>
    </div>
  );
}

export default function PersonMergesView() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [search, setSearch] = useState('');

  const load = () => fetchPersonMergeReview(['proposed', 'blocked'])
    .then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function merge(r) {
    if (!window.confirm(`Merge the two "${r.survivor_name}" records?\n\nEverything on the second record — client links, CH-code chases, tasks — moves onto the first, missing details are filled in, and the second record is deleted. This can't be undone from here.`)) return;
    setBusyId(r.id); setError(null); setFlash(null);
    try {
      const res = await applyPersonMerges([r.id]);
      if (res?.failed?.length) setError(`Not merged: ${res.failed[0].message}`);
      else setFlash(`Merged ${r.survivor_name}.`);
      await load();
    } catch (e) { setError(e.message); }
    setBusyId(null);
  }

  async function reject(r) {
    if (!window.confirm(`Keep "${r.survivor_name}" and "${r.absorbed_name}" as two different people?\n\nThe proposal is closed and won't be offered again.`)) return;
    setBusyId(r.id); setError(null); setFlash(null);
    try {
      await setPersonMergeVerdict([r.id], 'rejected');
      setFlash(`Kept as separate people: ${r.survivor_name} / ${r.absorbed_name}.`);
      await load();
    } catch (e) { setError(e.message); }
    setBusyId(null);
  }

  const q = search.trim().toLowerCase();
  const visible = (rows || []).filter((r) => !q
    || [r.survivor_name, r.absorbed_name, r.bm_person_ref, r.survivor_entities, r.absorbed_entities]
      .some((v) => (v || '').toLowerCase().includes(q)));
  const proposed = visible.filter((r) => r.verdict === 'proposed');
  const blocked = visible.filter((r) => r.verdict === 'blocked');

  const card = (r) => {
    const busy = busyId === r.id;
    const isBlocked = r.verdict === 'blocked';
    return (
      <div key={r.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={chipStyle('neutral')}>BM ref {r.bm_person_ref}</span>
          {r.absorbed_code_requests > 0 && (
            <span style={chipStyle('info')}>{r.absorbed_code_requests} CH-code chase{r.absorbed_code_requests === 1 ? '' : 's'} moves across</span>
          )}
          {isBlocked && <span style={chipStyle('danger')}>Blocked: {r.block_reason || 'names disagree'}</span>}
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <Side label="Keeps" name={r.survivor_name} dob={r.survivor_dob} code={r.survivor_code} entities={splitEntities(r.survivor_entities)} />
          <Side label="Merged in, then deleted" name={r.absorbed_name} dob={r.absorbed_dob} code={r.absorbed_code} entities={splitEntities(r.absorbed_entities)} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {isBlocked ? (
            <span style={{ fontSize: 12.5, color: '#64748b', alignSelf: 'center' }}>
              Blocked proposals can't be merged here — fix the name in BrightManager, or check they really are the same person.
            </span>
          ) : (
            <button onClick={() => merge(r)} disabled={busy} style={{ ...BTN.primary.sm, opacity: busy ? 0.5 : 1, cursor: busy ? 'wait' : 'pointer' }}>
              {busy ? 'Working…' : 'Merge'}
            </button>
          )}
          <button onClick={() => reject(r)} disabled={busy} style={{ ...BTN.secondary.sm, opacity: busy ? 0.5 : 1, cursor: busy ? 'wait' : 'pointer' }}>
            Not the same person
          </button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', margin: 0 }}>
            Possible duplicate people
          </h2>
          <p style={{ fontSize: 14, color: '#64748b', margin: '6px 0 0', maxWidth: 720 }}>
            The BrightManager import found two Athena records for the same BM person (same reference and date of birth).
            It never merges them itself. Check each pair and merge it, or mark it as two different people.
          </p>
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, client or BM ref…"
          style={{ padding: '7px 12px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, minWidth: 240, background: '#fff' }} />
      </div>

      {flash && <div style={{ background: tones.success.bg, color: tones.success.fg, borderRadius: 10, padding: '9px 14px', fontSize: 14, marginBottom: 12 }}>{flash}</div>}
      {error && <div style={{ color: '#b91c1c', fontSize: 14, marginBottom: 12 }}>{error}</div>}
      {!rows && !error && <div style={{ color: '#64748b', fontSize: 14 }}>Loading…</div>}

      {rows && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: '4px 0 8px' }}>To review <span style={{ color: '#94a3b8', fontWeight: 500 }}>{proposed.length}</span></div>
          {proposed.length === 0
            ? <div style={{ fontSize: 13.5, color: '#94a3b8', marginBottom: 18 }}>Nothing waiting.</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 22 }}>{proposed.map(card)}</div>}

          {blocked.length > 0 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: '4px 0 8px' }}>Blocked <span style={{ color: '#94a3b8', fontWeight: 500 }}>{blocked.length}</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{blocked.map(card)}</div>
            </>
          )}
        </>
      )}
    </div>
  );
}
