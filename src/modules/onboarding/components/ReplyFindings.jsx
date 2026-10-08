import React, { useState } from 'react';
import { Check, X } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { BTN } from '../../../lib/buttonStyles';
import { reviewReplyFinding } from '../api';

/*
  What a client's email appears to contain that we asked for (sql/359,
  onboarding-reply-scan). A suggestion only: Tick completes the step and
  copies the value into its note; Not it closes the suggestion.
*/
export function FindingRow({ finding, onChanged, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const open = finding.status === 'suggested';

  async function review(accept) {
    setBusy(true); setError(null);
    try { await reviewReplyFinding(finding.id, accept); onChanged?.(); }
    catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5, color: '#334155' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          <strong style={{ fontWeight: 600 }}>{finding.item_label}</strong>
          {finding.found_value && <span> — {finding.found_value}</span>}
          {finding.confidence !== 'high' && <span style={{ ...chipStyle('neutral'), marginLeft: 6 }}>{finding.confidence} confidence</span>}
          {!open && (
            <span style={{ ...chipStyle(finding.status === 'accepted' ? 'success' : 'neutral'), marginLeft: 6 }}>
              {finding.status === 'accepted' ? 'ticked' : 'dismissed'}
            </span>
          )}
        </div>
        {!compact && finding.evidence && <div style={{ color: '#64748b', fontStyle: 'italic' }}>“{finding.evidence}”</div>}
        {!compact && finding.communication && (
          <div style={{ fontSize: 12.5, color: '#94a3b8' }}>
            Email of {new Date(finding.communication.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
            {finding.communication.subject ? ` · ${finding.communication.subject}` : ''}
          </div>
        )}
        {error && <div style={{ color: tones.danger.fg, fontSize: 12.5 }}>{error}</div>}
      </div>
      {open && (
        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
          <button
            onClick={() => review(true)} disabled={busy} title="Tick the step Complete and keep the value in its note"
            style={{ ...BTN.secondary.sm, padding: '3px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, color: tones.success.fg }}
          >
            <Check size={11} /> Tick
          </button>
          <button
            onClick={() => review(false)} disabled={busy} title="Not what we asked for — dismiss"
            style={{ ...BTN.secondary.sm, padding: '3px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <X size={11} /> Not it
          </button>
        </div>
      )}
    </div>
  );
}

// The panel on the onboarding screen: only shows when something is waiting.
export default function ReplyFindingsPanel({ findings, onChanged }) {
  if (!findings?.length) return null;
  return (
    <div style={{ background: tones.warning.bg, border: `1px solid ${tones.warning.border}`, borderRadius: 12, padding: '14px 18px' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: tones.warning.fg, marginBottom: 4 }}>
        The client may have sent {findings.length === 1 ? 'this' : 'these'}
      </div>
      <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 10 }}>
        Read from their emails. Check each one before ticking — attachments aren’t visible to the reader.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {findings.map((f) => <FindingRow key={f.id} finding={f} onChanged={onChanged} />)}
      </div>
    </div>
  );
}
