import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Clock,
  CheckCircle,
  CheckCheck,
  Inbox,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { MODULES } from '../modules.config';
import { useAuth } from './AppShell';
import { supabase } from '../lib/supabase';
import JobReviewRadar from '../modules/job-review/DashboardRadar';
import { useDirectorDashboard, usePracticePulse, daysLate } from './homeDashboardData';

/* ─── Helpers ──────────────────────────────────────────────────── */
function formatDate() {
  const d = new Date();
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatCurrency(n) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function formatCurrency2dp(n) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function shortDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const thisMonthName = new Date().toLocaleDateString('en-GB', { month: 'long' });
const nextMonthName = new Date(
  new Date().getFullYear(),
  new Date().getMonth() + 1,
  1,
).toLocaleDateString('en-GB', { month: 'long' });

const FONT = "'Outfit', sans-serif";

/* ─── Section label ────────────────────────────────────────────── */
function SectionLabel({ children, note, action }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '12px',
        marginBottom: '16px',
      }}
    >
      <h2
        style={{
          fontFamily: FONT,
          fontSize: '13px',
          fontWeight: 600,
          textTransform: 'uppercase',
          color: '#94a3b8',
          letterSpacing: '0.04em',
        }}
      >
        {children}
      </h2>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '12px' }}>
        {note && (
          <span style={{ fontFamily: FONT, fontSize: '12px', color: '#cbd5e1' }}>{note}</span>
        )}
        {action}
      </span>
    </div>
  );
}

/* ─── Attention card ───────────────────────────────────────────── */
// Root is a div, not a button: cards can carry an inline action button
// (nested <button> inside <button> is invalid HTML).
function AttentionCard({ accent, icon: Icon, title, subtitle, onClick, action }) {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        width: '100%',
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        borderLeft: `3px solid ${accent}`,
        padding: '14px 18px',
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'left',
        marginBottom: '8px',
        transition: 'all 0.2s ease',
        boxSizing: 'border-box',
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.transform = 'translateY(-1px)';
          e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.06)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <Icon size={18} style={{ color: accent, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <p
          style={{
            fontFamily: FONT,
            fontSize: '14px',
            fontWeight: 500,
            color: '#0f172a',
            marginBottom: subtitle ? '2px' : 0,
          }}
        >
          {title}
        </p>
        {subtitle && (
          <p style={{ fontFamily: FONT, fontSize: '12px', color: '#94a3b8' }}>{subtitle}</p>
        )}
      </div>
      {action && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (action.state === 'idle') action.onClick();
          }}
          disabled={action.state !== 'idle'}
          title="Create a chase task in the Work Planner, assigned to the job owner"
          style={{
            fontFamily: FONT,
            fontSize: '12px',
            fontWeight: 600,
            padding: '6px 12px',
            borderRadius: '8px',
            border: action.state === 'done' ? '1px solid #bbf7d0' : '1px solid #e5e7eb',
            background: action.state === 'done' ? '#f0fdf4' : '#ffffff',
            color: action.state === 'done' ? '#059669' : '#0f172a',
            cursor: action.state === 'idle' ? 'pointer' : 'default',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {action.state === 'done' ? '✓ Chase raised' : action.state === 'saving' ? 'Raising…' : 'Raise chase task'}
        </button>
      )}
    </div>
  );
}

/* ─── Year-on-year chip (money: up = good = green) ─────────────── */
function YoYChip({ current, prior }) {
  if (typeof current !== 'number' || typeof prior !== 'number' || prior === 0) return null;
  const pct = Math.round(((current - prior) / Math.abs(prior)) * 100);
  const up = pct > 0;
  const down = pct < 0;
  const palette = up
    ? { color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' }
    : down
      ? { color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' }
      : { color: '#94a3b8', bg: '#f8fafc', border: '#e5e7eb' };
  return (
    <span
      title="vs the same fiscal period last year"
      style={{
        fontFamily: FONT,
        fontSize: '12px',
        fontWeight: 600,
        color: palette.color,
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: '999px',
        padding: '2px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {up ? '▲' : down ? '▼' : '–'} {Math.abs(pct)}% YoY
    </span>
  );
}

/* ─── Stat card ────────────────────────────────────────────────── */
function StatCard({ label, value, sub, chip, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: 1,
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        padding: '20px 24px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = '0 8px 24px rgba(56, 189, 248, 0.07)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <p
        style={{
          fontFamily: FONT,
          fontSize: '12px',
          fontWeight: 500,
          color: '#94a3b8',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
          marginBottom: '8px',
        }}
      >
        {label}
      </p>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONT, fontSize: '26px', fontWeight: 700, color: '#0f172a' }}>
          {value}
        </span>
        {chip}
      </div>
      {sub && (
        <p style={{ fontFamily: FONT, fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>
          {sub}
        </p>
      )}
    </div>
  );
}

/* ─── Week-on-week delta chip ──────────────────────────────────── */
// More outstanding work than the last digest = red; less = green.
function DeltaChip({ delta }) {
  if (delta === null || delta === undefined) return null;
  const up = delta > 0;
  const down = delta < 0;
  const palette = up
    ? { color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' }
    : down
      ? { color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' }
      : { color: '#94a3b8', bg: '#f8fafc', border: '#e5e7eb' };
  const label = up ? `▲ ${delta}` : down ? `▼ ${Math.abs(delta)}` : '–';
  return (
    <span
      title="change since the last deadline-digest snapshot"
      style={{
        fontFamily: FONT,
        fontSize: '12px',
        fontWeight: 600,
        color: palette.color,
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: '999px',
        padding: '2px 8px',
      }}
    >
      {label}
    </span>
  );
}

/* ─── Deadline card ────────────────────────────────────────────── */
function DeadlineCard({ title, big, bigColor = '#0f172a', unit, pill, delta, rows, footer, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        padding: '20px 24px',
        cursor: onClick ? 'pointer' : 'default',
        display: 'flex',
        flexDirection: 'column',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.05)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <p
        style={{
          fontFamily: FONT,
          fontSize: '12px',
          fontWeight: 500,
          color: '#94a3b8',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
          marginBottom: '10px',
        }}
      >
        {title}
      </p>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONT, fontSize: '32px', fontWeight: 700, color: bigColor }}>
          {big}
        </span>
        <span style={{ fontFamily: FONT, fontSize: '13px', color: '#64748b' }}>{unit}</span>
        {pill && (
          <span
            style={{
              fontFamily: FONT,
              fontSize: '12px',
              fontWeight: 600,
              color: '#b91c1c',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '999px',
              padding: '2px 10px',
            }}
          >
            {pill}
          </span>
        )}
        <DeltaChip delta={delta} />
      </div>
      {rows && (
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {rows}
        </div>
      )}
      <div style={{ flex: 1 }} />
      {footer && (
        <p
          style={{
            fontFamily: FONT,
            fontSize: '12px',
            color: '#64748b',
            marginTop: '14px',
            paddingTop: '12px',
            borderTop: '1px solid #f1f5f9',
          }}
        >
          {footer}
        </p>
      )}
    </div>
  );
}

function DeadlineRow({ label, value, delta }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontFamily: FONT, fontSize: '13px', color: '#64748b' }}>{label}</span>
      <span
        style={{
          fontFamily: FONT,
          fontSize: '13px',
          fontWeight: 600,
          color: '#0f172a',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        {value}
        <DeltaChip delta={delta} />
      </span>
    </div>
  );
}

function ServiceChip({ service, count, active, onClick }) {
  return (
    <span
      onClick={onClick}
      style={{
        fontFamily: FONT,
        fontSize: '12px',
        color: active ? '#0c4a6e' : '#475569',
        backgroundColor: active ? '#e0f2fe' : '#f8fafc',
        border: `1px solid ${active ? '#7dd3fc' : '#e5e7eb'}`,
        borderRadius: '999px',
        padding: '3px 10px',
        whiteSpace: 'nowrap',
        cursor: onClick ? 'pointer' : 'inherit',
      }}
    >
      {service} <strong style={{ color: active ? '#0c4a6e' : '#0f172a' }}>{count}</strong>
    </span>
  );
}

/* ─── Overdue-work drill-down ──────────────────────────────────── */
// The planner's Ready Now deliberately covers only SA/AA, so this panel is
// the one place overdue VAT / payroll / management accounts are listable.
function OverduePanel({ jobs, byService, service, onService, onRow }) {
  const shown = service === 'all' ? jobs : jobs.filter((j) => (j.service || 'Other') === service);
  const th = {
    fontFamily: FONT,
    fontSize: '12px',
    fontWeight: 600,
    color: '#475569',
    textAlign: 'left',
    padding: '8px 12px',
    backgroundColor: '#f8fafc',
    whiteSpace: 'nowrap',
  };
  const td = {
    fontFamily: FONT,
    fontSize: '13px',
    color: '#334155',
    padding: '7px 12px',
    borderTop: '1px solid #f1f5f9',
    whiteSpace: 'nowrap',
  };
  return (
    <div
      style={{
        marginTop: '16px',
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '6px',
          padding: '14px 16px',
        }}
      >
        <ServiceChip
          service="All"
          count={jobs.length}
          active={service === 'all'}
          onClick={() => onService('all')}
        />
        {byService.map((r) => (
          <ServiceChip
            key={r.service}
            service={r.service}
            count={r.count}
            active={service === r.service}
            onClick={() => onService(r.service)}
          />
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Client</th>
              <th style={th}>Service</th>
              <th style={th}>Task</th>
              <th style={th}>Owner</th>
              <th style={th}>Due</th>
              <th style={{ ...th, textAlign: 'right' }}>Days late</th>
              <th style={{ ...th, textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((j) => (
              <tr
                key={j.id}
                onClick={() => onRow(j)}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f8fafc';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <td style={{ ...td, fontWeight: 500, color: '#0f172a' }}>
                  {j.entity?.name || '—'}
                </td>
                <td style={td}>{j.service || 'Other'}</td>
                <td
                  style={{
                    ...td,
                    maxWidth: '260px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    color: '#64748b',
                  }}
                >
                  {j.bm_task_name}
                </td>
                <td style={td}>{j.owner?.name ? j.owner.name.split(' ')[0] : '—'}</td>
                <td style={td}>{shortDate(j.bm_deadline)}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#b91c1c' }}>
                  {daysLate(j.bm_deadline)}
                </td>
                <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>
                  {bmStatus(j.bm_status)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Ops mini-stat ────────────────────────────────────────────── */
function OpsStat({ label, value, detail, tone = 'default', onClick }) {
  const valueColor = tone === 'warn' ? '#b45309' : tone === 'bad' ? '#b91c1c' : '#0f172a';
  return (
    <div
      onClick={onClick}
      style={{
        flex: 1,
        minWidth: '150px',
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        padding: '14px 18px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.transform = 'translateY(-1px)';
          e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.05)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <p
        style={{
          fontFamily: FONT,
          fontSize: '11px',
          fontWeight: 500,
          color: '#94a3b8',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
          marginBottom: '4px',
        }}
      >
        {label}
      </p>
      <p style={{ fontFamily: FONT, fontSize: '20px', fontWeight: 700, color: valueColor }}>
        {value}
        {detail && (
          <span
            style={{ fontSize: '12px', fontWeight: 500, color: '#94a3b8', marginLeft: '8px' }}
          >
            {detail}
          </span>
        )}
      </p>
    </div>
  );
}

/* ─── Module status dot (staff view) ───────────────────────────── */
function ModuleStatusDot({ mod }) {
  const dotStyle = { width: '8px', height: '8px', borderRadius: '50%' };
  if (mod.status === 'live') return <span style={{ ...dotStyle, backgroundColor: '#38bdf8' }} />;
  if (mod.status === 'beta') return <span style={{ ...dotStyle, backgroundColor: '#f59e0b' }} />;
  return (
    <span
      style={{ ...dotStyle, backgroundColor: 'transparent', border: '1.5px solid #94a3b8' }}
    />
  );
}

/* ─── Attention queue assembly ─────────────────────────────────── */
// BrightManager status labels that read like system codes → plain English.
const BM_STATUS_LABELS = { 'No Latest Action': 'Not started' };
const bmStatus = (s) => BM_STATUS_LABELS[s] || s || 'No status';

// Priority order: things already late or broken (red), money waiting on Bobby
// (green — accepted quotes to commit), then everything pending (amber/sky).
function buildAttentionItems(data, navigate) {
  const items = [];
  const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;

  // One row per late CH filing — each names the client, how late, and the BM
  // status, so the count on the deadline card is always reconcilable.
  data.ch.overdueList.forEach((r) => {
    const late = daysLate(r.bm_deadline);
    const owner = r.owner?.name ? ` · ${r.owner.name.split(' ')[0]}` : '';
    items.push({
      id: `ch-${r.id}`,
      accent: '#ef4444',
      icon: AlertTriangle,
      title: `${r.entity?.name || 'Unknown client'} — accounts ${late} day${late === 1 ? '' : 's'} late at Companies House`,
      subtitle: `Due ${shortDate(r.bm_deadline)} · ${bmStatus(r.bm_status)}${owner}`,
      onClick: () => (r.entity?.id ? navigate(`/clients/${r.entity.id}`) : navigate('/planner/ready?service=Acc&due=overdue')),
      // Payload for the inline "Raise chase task" verb — kept as plain data so
      // this builder stays pure; the card wires it to the insert.
      chase: r.entity?.id
        ? {
            entityId: r.entity.id,
            entityName: r.entity.name,
            taskName: r.bm_task_name || 'Companies House accounts',
            deadline: r.bm_deadline,
            ownerName: r.owner?.name || null,
          }
        : null,
    });
  });
  if (data.ch.overdue > data.ch.overdueList.length) {
    items.push({
      id: 'ch-overdue-more',
      accent: '#ef4444',
      icon: AlertTriangle,
      title: `${plural(data.ch.overdue - data.ch.overdueList.length, 'more late Companies House filing')}`,
      subtitle: 'Open the planner for the full list',
      onClick: () => navigate('/planner/ready?service=Acc&due=overdue'),
    });
  }

  // Late Self Assessment returns (past a 31 Jan) — penalties accruing.
  // Names arrive as "Surname, Firstname", so separate with a dot not a comma.
  if (data.sa.overdueList.length > 0) {
    const names = data.sa.overdueList
      .map((r) => r.entity?.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(' · ');
    items.push({
      id: 'sa-overdue',
      accent: '#ef4444',
      icon: AlertTriangle,
      title: `${plural(data.sa.overdueList.length, 'Self Assessment return')} past the filing deadline`,
      subtitle: names + (data.sa.overdueList.length > 3 ? '…' : ''),
      onClick: () => navigate('/planner/ready?service=SA&due=overdue'),
    });
  }

  data.onboarding.issues.forEach((o) => {
    items.push({
      id: `onb-${o.id}`,
      accent: '#ef4444',
      icon: AlertTriangle,
      title: `${o.entity?.name || 'Onboarding'} — flagged with issues`,
      subtitle: 'Onboarding needs unblocking',
      onClick: () => navigate('/onboarding'),
    });
  });

  data.quotes.accepted.forEach((q) => {
    items.push({
      id: `acc-${q.id}`,
      accent: '#22c55e',
      icon: CheckCheck,
      title: `${q.relationship_group || q.quote_ref} accepted ${q.quote_ref}${
        q.accepted_at ? ` — ${shortDate(q.accepted_at)}` : ''
      }`,
      subtitle: `${formatCurrency2dp(q.monthly_gross || 0)}/mo · ${formatCurrency2dp(
        q.annual_total || 0,
      )}/yr inc VAT · review and push to QBO`,
      onClick: () => navigate(`/manage/quotes/${q.id}`),
    });
  });

  data.quotes.pendingApproval.forEach((q) => {
    items.push({
      id: `pend-${q.id}`,
      accent: '#f59e0b',
      icon: Clock,
      title: `${q.relationship_group || q.quote_ref} — quote awaiting approval`,
      subtitle: q.quote_ref,
      onClick: () => navigate(`/manage/quotes/${q.id}`),
    });
  });

  data.quotes.expiring.forEach((q) => {
    items.push({
      id: `exp-${q.id}`,
      accent: '#f87171',
      icon: AlertTriangle,
      title: `${q.relationship_group || q.quote_ref} — accepted quote expires ${shortDate(
        q.valid_until,
      )}`,
      subtitle: q.quote_ref,
      onClick: () => navigate(`/manage/quotes/${q.id}`),
    });
  });

  data.serviceRequests.forEach((r) => {
    items.push({
      id: `sr-${r.id}`,
      accent: '#38bdf8',
      icon: Inbox,
      title: `${r.entity?.name || 'A client'} requested ${r.service_title || 'a new service'} via the portal`,
      subtitle: `Raised ${shortDate(r.created_at)} — respond with a quote`,
      // The card's own copy says the remedy is a quote — link to the quote form.
      onClick: () => (r.entity_id ? navigate(`/manage/quotes/new?entity=${r.entity_id}`) : navigate('/onboarding')),
    });
  });

  if (data.billingNeedsReview > 0) {
    items.push({
      id: 'billing-review',
      accent: '#f59e0b',
      icon: Clock,
      title: `${plural(data.billingNeedsReview, 'live billing record')} flagged for review`,
      subtitle: 'Billing review',
      onClick: () => navigate('/manage/billing/review'),
    });
  }

  return items;
}

// One-line summary for the collapsed state — counts by kind, worst first.
function attentionSummary(data) {
  const seg = [];
  const p = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;
  if (data.ch.overdue > 0) seg.push(`${p(data.ch.overdue, 'CH filing')} late`);
  if (data.sa.overdueList.length > 0) seg.push(`${p(data.sa.overdueList.length, 'SA return')} late`);
  if (data.onboarding.issues.length > 0) seg.push(p(data.onboarding.issues.length, 'onboarding issue'));
  if (data.quotes.accepted.length > 0) seg.push(`${p(data.quotes.accepted.length, 'quote')} to commit`);
  if (data.quotes.pendingApproval.length > 0) seg.push(`${p(data.quotes.pendingApproval.length, 'approval')} waiting`);
  if (data.quotes.expiring.length > 0) seg.push(`${p(data.quotes.expiring.length, 'quote')} expiring`);
  if (data.serviceRequests.length > 0) seg.push(p(data.serviceRequests.length, 'service request'));
  if (data.billingNeedsReview > 0) seg.push(p(data.billingNeedsReview, 'billing review'));
  return seg;
}

/* ─── Collapsed attention summary card ─────────────────────────── */
function AttentionSummaryCard({ items, segments, onExpand }) {
  const hasRed = items.some((i) => i.accent === '#ef4444' || i.accent === '#f87171');
  const accent = hasRed ? '#ef4444' : '#f59e0b';
  const Icon = hasRed ? AlertTriangle : Clock;
  return (
    <button
      onClick={onExpand}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        width: '100%',
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        borderLeft: `3px solid ${accent}`,
        padding: '14px 18px',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.06)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <Icon size={18} style={{ color: accent, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <p
          style={{
            fontFamily: FONT,
            fontSize: '14px',
            fontWeight: 500,
            color: '#0f172a',
            marginBottom: '2px',
          }}
        >
          {items.length} item{items.length === 1 ? '' : 's'} need{items.length === 1 ? 's' : ''} your
          attention
        </p>
        <p style={{ fontFamily: FONT, fontSize: '12px', color: '#94a3b8' }}>
          {segments.join(' · ')}
        </p>
      </div>
      <ChevronDown size={18} style={{ color: '#94a3b8', flexShrink: 0 }} />
    </button>
  );
}

/* ─── HomeScreen ───────────────────────────────────────────────── */
export default function HomeScreen() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  const firstName = profile?.name?.split(' ')[0] || 'there';
  const isOwner = profile?.can_manage_portal === true;
  const canSeeAttention = profile?.can_approve_quotes === true || isOwner;
  // AVA's own books — deliberately a separate flag from portal admin, so the
  // practice's financials stay Bobby-only even among admins.
  const canSeePulse = profile?.can_view_practice_financials === true;

  const { loading, data } = useDirectorDashboard(isOwner || canSeeAttention);
  const { loading: pulseLoading, pulse, error: pulseError } = usePracticePulse(canSeePulse);

  // Less is more: the attention queue opens collapsed, one summary line.
  const [attentionOpen, setAttentionOpen] = useState(false);
  const attentionRef = useRef(null);
  // Collapsing removes ~a screen of cards above the fold; snap back to the
  // section header so the collapse is actually visible.
  const collapseAttention = () => {
    setAttentionOpen(false);
    requestAnimationFrame(() =>
      attentionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };

  // The 86-late-jobs list lives here, not in the planner — Ready Now only
  // covers SA/AA by design, so overdue VAT/payroll/etc have no page of their own.
  const [overdueOpen, setOverdueOpen] = useState(false);
  const [overdueService, setOverdueService] = useState('all');

  // Inline verb on late-filing cards: one click creates a chase task in the
  // Work Planner (same insert as the client page's Raise Action), assigned to
  // the job owner, falling back to whoever clicked.
  const [chaseState, setChaseState] = useState({}); // item.id -> 'saving' | 'done'
  const raiseChase = async (itemId, chase) => {
    setChaseState((s) => ({ ...s, [itemId]: 'saving' }));
    try {
      let assigneeId = profile?.id || null;
      if (chase.ownerName) {
        const { data: staff } = await supabase
          .from('staff_profiles')
          .select('id, name')
          .ilike('name', `%${chase.ownerName.split(' ')[0]}%`)
          .limit(1);
        if (staff?.[0]?.id) assigneeId = staff[0].id;
      }
      const { error } = await supabase.from('quick_tasks').insert({
        title: `Chase: ${chase.entityName} — ${chase.taskName} overdue since ${shortDate(chase.deadline)}`,
        entity_id: chase.entityId,
        service: 'Admin',
        assignee_id: assigneeId,
        due_date: new Date(Date.now() + 5 * 86400000).toISOString(),
        planned_date: null,
        duration: 15,
        notes: 'Raised from the home dashboard attention queue',
        sort_order: 0,
        created_by: profile?.id,
      });
      if (error) throw error;
      setChaseState((s) => ({ ...s, [itemId]: 'done' }));
    } catch (e) {
      console.error('[HomeScreen] raiseChase', e);
      setChaseState((s) => { const next = { ...s }; delete next[itemId]; return next; });
    }
  };

  const attentionItems = data ? buildAttentionItems(data, navigate) : [];

  // Staff (non-owner) keep the module strip as their orientation aid.
  const visibleModules = MODULES.filter((mod) => {
    if (mod.status !== 'live') return false;
    if (!mod.permissions || mod.permissions.length === 0) return true;
    return mod.permissions.every((p) => profile?.[p] === true);
  });

  const bmNote = data?.bmDataAsOf
    ? `work data from BrightManager · refreshed ${shortDate(data.bmDataAsOf)}`
    : null;

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', padding: '40px 24px' }}>
      {/* ── Header row ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: '36px',
        }}
      >
        <h1
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: '28px',
            fontWeight: 500,
            color: '#0f172a',
          }}
        >
          {getGreeting()}, {firstName}
        </h1>
        <span style={{ fontFamily: FONT, fontSize: '13px', color: '#94a3b8' }}>
          {formatDate()}
        </span>
      </div>

      {/* ── Needs attention ── */}
      {canSeeAttention && (
        <div ref={attentionRef} style={{ marginBottom: '36px', scrollMarginTop: '24px' }}>
          <SectionLabel
            action={
              !loading && attentionItems.length > 0 ? (
                <button
                  onClick={() =>
                    attentionOpen ? collapseAttention() : setAttentionOpen(true)
                  }
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontFamily: FONT,
                    fontSize: '12px',
                    fontWeight: 600,
                    color: '#38bdf8',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  {attentionOpen ? (
                    <>
                      Show less <ChevronUp size={14} />
                    </>
                  ) : (
                    <>
                      Show all {attentionItems.length} <ChevronDown size={14} />
                    </>
                  )}
                </button>
              ) : null
            }
          >
            Needs attention
          </SectionLabel>
          {loading ? (
            <p style={{ fontFamily: FONT, fontSize: '13px', color: '#94a3b8' }}>Checking…</p>
          ) : attentionItems.length === 0 ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                backgroundColor: '#ffffff',
                borderRadius: '12px',
                border: '1px solid #e5e7eb',
                borderLeft: '3px solid #22c55e',
                padding: '14px 18px',
              }}
            >
              <CheckCircle size={18} style={{ color: '#22c55e', flexShrink: 0 }} />
              <p style={{ fontFamily: FONT, fontSize: '14px', fontWeight: 500, color: '#0f172a' }}>
                Nothing needs your attention right now.
              </p>
            </div>
          ) : !attentionOpen ? (
            <AttentionSummaryCard
              items={attentionItems}
              segments={attentionSummary(data)}
              onExpand={() => setAttentionOpen(true)}
            />
          ) : (
            <>
              {attentionItems.slice(0, 12).map((item) => (
                <AttentionCard
                  key={item.id}
                  accent={item.accent}
                  icon={item.icon}
                  title={item.title}
                  subtitle={item.subtitle}
                  onClick={item.onClick}
                  action={
                    item.chase
                      ? {
                          state: chaseState[item.id] || 'idle',
                          onClick: () => raiseChase(item.id, item.chase),
                        }
                      : null
                  }
                />
              ))}
              <button
                onClick={collapseAttention}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontFamily: FONT,
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#38bdf8',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px 0',
                  marginTop: '4px',
                }}
              >
                <ChevronUp size={16} /> Show less
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Practice pulse — AVA actuals from QuickBooks (Bobby only) ── */}
      {canSeePulse && (
        <div style={{ marginBottom: '36px' }}>
          <SectionLabel
            note={
              pulse?.pulledAt
                ? `Almond Valley actuals from QuickBooks · ${
                    pulse.fromCache ? 'cached ' : 'pulled '
                  }${shortDate(pulse.pulledAt)} · visible only to you`
                : 'visible only to you'
            }
          >
            Practice pulse
          </SectionLabel>
          {pulseLoading ? (
            <p style={{ fontFamily: FONT, fontSize: '13px', color: '#94a3b8' }}>
              Pulling the numbers from QuickBooks…
            </p>
          ) : pulseError === 'reconnect' || pulseError === 'no-connection' ? (
            <AttentionCard
              accent="#f59e0b"
              icon={Clock}
              title="QuickBooks needs reconnecting before the pulse can load"
              subtitle="Open the Client Dashboard and reconnect Almond Valley Accounting"
              onClick={() => navigate('/client-dashboard')}
            />
          ) : (
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              <StatCard
                label="Revenue — fiscal YTD"
                value={
                  pulse?.plFytd?.income != null ? formatCurrency(pulse.plFytd.income) : '—'
                }
                chip={
                  <YoYChip current={pulse?.plFytd?.income} prior={pulse?.plFytdPrior?.income} />
                }
                sub={[
                  pulse?.plFytd?.period?.start
                    ? `since ${shortDate(pulse.plFytd.period.start)}`
                    : null,
                  pulse?.plFytdPrior?.income != null
                    ? `${formatCurrency(pulse.plFytdPrior.income)} same period last year`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onClick={() => navigate('/client-dashboard')}
              />
              <StatCard
                label="Net operating income — fiscal YTD"
                value={
                  pulse?.plFytd?.net_operating_income != null
                    ? formatCurrency(pulse.plFytd.net_operating_income)
                    : '—'
                }
                chip={
                  <YoYChip
                    current={pulse?.plFytd?.net_operating_income}
                    prior={pulse?.plFytdPrior?.net_operating_income}
                  />
                }
                sub={[
                  pulse?.plFytd?.net_operating_income != null && pulse?.plFytd?.income > 0
                    ? `${Math.round(
                        (pulse.plFytd.net_operating_income / pulse.plFytd.income) * 100,
                      )}% margin`
                    : null,
                  pulse?.plFytd?.net_income != null
                    ? `${formatCurrency(pulse.plFytd.net_income)} net after dividends`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onClick={() => navigate('/client-dashboard')}
              />
              <StatCard
                label="Cash at bank"
                value={
                  pulse?.balances?.cash != null ? formatCurrency(pulse.balances.cash) : '—'
                }
                sub={
                  pulse?.balances?.bank_account_count
                    ? `across ${pulse.balances.bank_account_count} bank account${
                        pulse.balances.bank_account_count === 1 ? '' : 's'
                      }`
                    : null
                }
                onClick={() => navigate('/client-dashboard')}
              />
              <StatCard
                label="Debtors"
                value={
                  pulse?.balances?.debtors != null
                    ? formatCurrency(pulse.balances.debtors)
                    : '—'
                }
                sub="owed to the practice"
                onClick={() => navigate('/client-dashboard')}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Deadlines (owner only) — live view of the Monday digest ── */}
      {isOwner && data && (
        <div style={{ marginBottom: '36px' }}>
          <SectionLabel
            note={[bmNote, data.wow ? `▲▼ vs digest ${shortDate(data.wow.since)}` : null]
              .filter(Boolean)
              .join(' · ')}
          >
            Deadlines
          </SectionLabel>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '16px',
            }}
          >
            <DeadlineCard
              title="Companies House accounts"
              big={data.ch.thisMonth}
              unit={`due in ${thisMonthName}`}
              pill={data.ch.overdue > 0 ? `${data.ch.overdue} past deadline` : null}
              delta={data.wow?.chThisMonth}
              rows={
                <>
                  <DeadlineRow label={nextMonthName} value={data.ch.nextMonth} />
                  <DeadlineRow
                    label="Next 6 months"
                    value={data.ch.sixMonths}
                    delta={data.wow?.chSixMonths}
                  />
                </>
              }
              footer={`~${data.ch.runRate} filings a week clears the 6-month pile`}
              onClick={() => navigate('/planner/ready?service=Acc')}
            />
            <DeadlineCard
              title="Self Assessment"
              big={data.sa.count}
              unit={`returns due 31 Jan ${data.sa.year}`}
              delta={data.wow?.sa}
              footer={`~${data.sa.runRate} a week from now stays on track`}
              onClick={() => navigate('/planner/ready?service=SA')}
            />
            <DeadlineCard
              title="Work past BM deadline"
              big={data.overdueWork.total}
              bigColor={data.overdueWork.total > 0 ? '#b91c1c' : '#0f172a'}
              unit="open jobs late"
              delta={data.wow?.overdueTotal}
              rows={
                data.overdueWork.byService.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {data.overdueWork.byService.slice(0, 5).map((r) => (
                      <ServiceChip key={r.service} service={r.service} count={r.count} />
                    ))}
                    {data.overdueWork.byService.length > 5 && (
                      <ServiceChip
                        service="other"
                        count={data.overdueWork.byService
                          .slice(5)
                          .reduce((s, r) => s + r.count, 0)}
                      />
                    )}
                  </div>
                )
              }
              footer={overdueOpen ? 'Hide the list' : 'Click to list every late job'}
              onClick={() => setOverdueOpen((o) => !o)}
            />
          </div>
          {overdueOpen && data.overdueWork.jobs.length > 0 && (
            <OverduePanel
              jobs={data.overdueWork.jobs}
              byService={data.overdueWork.byService}
              service={overdueService}
              onService={setOverdueService}
              onRow={(j) => j.entity?.id && navigate(`/clients/${j.entity.id}`)}
            />
          )}
        </div>
      )}

      {/* ── Operations (owner only) ── */}
      {isOwner && data && (
        <div style={{ marginBottom: '36px' }}>
          <SectionLabel>Operations</SectionLabel>
          <JobReviewRadar />
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <OpsStat
              label="Onboardings in flight"
              value={data.onboarding.inFlight}
              detail={
                data.onboarding.issues.length > 0
                  ? `${data.onboarding.issues.length} with issues`
                  : null
              }
              tone={data.onboarding.issues.length > 0 ? 'warn' : 'default'}
              onClick={() => navigate('/onboarding')}
            />
            <OpsStat
              label="CH codes"
              value={data.chCodes.awaiting + data.chCodes.stalled}
              detail={data.chCodes.stalled > 0 ? `${data.chCodes.stalled} stalled` : 'in progress'}
              tone={data.chCodes.stalled > 0 ? 'warn' : 'default'}
              onClick={() => navigate('/onboarding/ch-codes')}
            />
            <OpsStat
              label="Admin tasks"
              value={data.adminTasksOpen}
              detail="open"
              onClick={() => navigate('/admin/tasks')}
            />
            <OpsStat
              label="Issues log"
              value={data.issuesOpen}
              detail="open"
              tone={data.issuesOpen > 0 ? 'warn' : 'default'}
              onClick={() => navigate('/issues')}
            />
          </div>
        </div>
      )}

      {/* ── Module strip (staff orientation — owners know the sidebar) ── */}
      {!isOwner && (
        <div>
          <SectionLabel>Modules</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'center' }}>
            {visibleModules.map((mod) => (
              <div key={mod.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ModuleStatusDot mod={mod} />
                <span
                  style={{
                    fontFamily: FONT,
                    fontSize: '13px',
                    fontWeight: 500,
                    color: '#1e293b',
                  }}
                >
                  {mod.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
