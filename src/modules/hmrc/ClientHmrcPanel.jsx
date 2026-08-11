import React, { useEffect, useState } from 'react';
import { Landmark, ExternalLink, CheckCircle } from 'lucide-react';
import { fmtGbp, fmtGbpDetailed } from '../../lib/money';
import { useAuth } from '../../shell/AppShell';
import { fetchSchemesForEntity, saveReview } from './hmrcApi';
import { font, TIERS, REVIEW_STATUSES, Pill, ageLabel, shortDate, dateTime, inputStyle } from './hmrcShared';
import RefreshButton from './RefreshButton';

// HMRC's view of this client, on the client page.
//
// The /hmrc module answers "who owes us a chase this week". This answers the
// other half — you are already on a client, about to ring them or price them,
// and whether HMRC is chasing them for £20k is context you need without
// remembering to go and look.
//
// Renders NOTHING when the client has no PAYE scheme on the agent list. Most
// clients do not, and an empty panel on 400 client pages is worse than no
// panel. When a scheme IS clear it still shows a one-line confirmation: "we
// checked, nothing owed" is a fact worth having on the page.

export default function ClientHmrcPanel({ entityId }) {
  const { profile } = useAuth();
  const [schemes, setSchemes] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!entityId) return undefined;
    fetchSchemesForEntity(entityId)
      .then((rows) => { if (!cancelled) setSchemes(rows); })
      // Silent on failure: this is supporting context on someone else's page,
      // not the reason they came here. The /hmrc module surfaces real errors.
      .catch(() => { if (!cancelled) setSchemes([]); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [entityId]);

  if (!loaded || schemes.length === 0) return null;

  return (
    <div style={{ marginBottom: 20 }}>
      {schemes.map((s) => (
        <SchemeCard key={s.paye_ref} scheme={s} profile={profile} entityId={entityId} onSaved={(patch) => {
          setSchemes((prev) => prev.map((r) => (r.paye_ref === s.paye_ref ? { ...r, ...patch } : r)));
        }} />
      ))}
    </div>
  );
}

function SchemeCard({ scheme, profile, entityId, onSaved }) {
  const [saving, setSaving] = useState(false);
  const owing = Number(scheme.total_debt || 0) > 0;
  const tier = TIERS[scheme.chase_tier] || TIERS[4];
  const link = `/hmrc/paye?scheme=${encodeURIComponent(scheme.paye_ref)}`;

  const save = async (patch) => {
    onSaved(patch);
    setSaving(true);
    try {
      await saveReview({
        payeRef: scheme.paye_ref,
        status: patch.review_status,
        notes: patch.review_notes,
        staffId: profile?.id,
      });
    } catch {
      // Same reasoning as the load: never break the client page over this.
      // The status is re-read from the database on next open.
    } finally {
      setSaving(false);
    }
  };

  // Nothing owed — one quiet line, and the date it was checked.
  if (!owing) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap',
        border: '1px solid #dcfce7', background: '#f0fdf4', borderRadius: 12,
        padding: '10px 14px', fontFamily: font, marginBottom: 10,
      }}>
        <CheckCircle size={15} style={{ color: '#059669', flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: '#166534' }}>PAYE clear with HMRC</span>
        <span style={{ fontSize: 12, color: '#4d7c5f' }}>
          Nothing owed on {scheme.paye_ref} as at {shortDate(scheme.scraped_at)}
        </span>
        {scheme.claiming_ea && <Pill colour="#7c3aed" bg="#faf5ff" style={{ fontSize: 10 }}>Employment Allowance</Pill>}
        <div style={{ flex: 1 }} />
        {/* "Clear" is the answer most likely to be doubted — it is the one people
            want to re-check before telling a client they owe nothing. */}
        <RefreshButton entityId={entityId} compact />
        <a href={link} style={linkStyle} title="Open the full HMRC position for this scheme">
          HMRC detail <ExternalLink size={11} />
        </a>
      </div>
    );
  }

  const st = REVIEW_STATUSES.find((r) => r.value === scheme.review_status) || REVIEW_STATUSES[0];

  return (
    <div style={{
      border: `1px solid ${tier.colour}33`, background: tier.bg, borderRadius: 12,
      padding: '13px 16px', fontFamily: font, marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginBottom: 10 }}>
        <Landmark size={16} style={{ color: tier.colour, flexShrink: 0 }} />
        <span style={{ fontSize: 13.5, fontWeight: 700, color: '#0f172a' }}>Owes HMRC</span>
        <Pill colour={tier.colour} bg="#fff" title={tier.hint}>{tier.label}</Pill>
        <span style={{ fontSize: 11.5, color: '#64748b' }}>
          PAYE {scheme.paye_ref} · scraped {dateTime(scheme.scraped_at)}
        </span>
        <div style={{ flex: 1 }} />
        <RefreshButton entityId={entityId} compact />
        <a href={link} style={linkStyle} title="Open the full breakdown — overdue charges, monthly grid, payments">
          Full breakdown <ExternalLink size={11} />
        </a>
      </div>

      <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', marginBottom: 10 }}>
        <Figure label="Total owed" value={fmtGbpDetailed(scheme.total_debt)} colour="#b91c1c" big />
        {Number(scheme.accruing_interest) > 0 && (
          <Figure label="Accruing interest" value={fmtGbpDetailed(scheme.accruing_interest)} colour="#c2410c" />
        )}
        {scheme.oldest_due_date && (
          <Figure
            label="Oldest arrears"
            value={ageLabel(scheme.days_oldest_overdue)}
            sub={`${scheme.oldest_overdue_year} · due ${shortDate(scheme.oldest_due_date)}`}
            colour="#475569"
          />
        )}
        {scheme.overdue_items > 0 && (
          <Figure
            label="Overdue charges"
            value={scheme.overdue_items}
            sub={scheme.penalty_items > 0 ? `incl. ${scheme.penalty_items} penalty · ${fmtGbp(scheme.penalties)}` : undefined}
            colour="#475569"
          />
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 11 }}>
        {scheme.payment_plan && <Pill colour="#0369a1" bg="#fff" title="HMRC has a time-to-pay arrangement in place — monitor, do not chase">Payment plan</Pill>}
        {scheme.variable_dd && <Pill colour="#059669" bg="#fff" title="Paying by variable direct debit">Variable DD</Pill>}
        {scheme.claiming_ea && <Pill colour="#7c3aed" bg="#fff" title="Employment Allowance is being claimed against this scheme">Employment Allowance</Pill>}
      </div>

      {/* Triage lives on the same row as the module's list, writing to the same
          hmrc_debt_reviews row — mark it up here and it is marked up there. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={scheme.review_status || 'pending'}
          onChange={(e) => save({ review_status: e.target.value })}
          style={{ ...inputStyle, width: 'auto', background: '#fff', color: st.colour, fontWeight: 600, border: `1px solid ${st.colour}44` }}
        >
          {REVIEW_STATUSES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <NoteInput
          value={scheme.review_notes}
          onSave={(v) => save({ review_notes: v })}
        />
        {saving && <span style={{ fontSize: 11, color: '#94a3b8' }}>Saving…</span>}
      </div>
    </div>
  );
}

function NoteInput({ value, onSave }) {
  const [v, setV] = useState(value || '');
  useEffect(() => setV(value || ''), [value]);
  return (
    <input
      value={v}
      placeholder="What have we done about it?"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== (value || '')) onSave(v); }}
      style={{ ...inputStyle, flex: 1, minWidth: 220, background: '#fff' }}
    />
  );
}

function Figure({ label, value, sub, colour, big }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: big ? 22 : 16, fontWeight: 700, color: colour, marginTop: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

const linkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 12, fontWeight: 600, color: '#0e7fe0', textDecoration: 'none',
};
