import React, { useEffect, useRef, useState } from 'react';
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
        gap: '10px',
        marginBottom: '10px',
      }}
    >
      <h2
        style={{
          fontFamily: FONT,
          fontSize: '12px',
          fontWeight: 600,
          textTransform: 'uppercase',
          color: '#94a3b8',
          letterSpacing: '0.04em',
        }}
      >
        {children}
      </h2>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '10px', minWidth: 0 }}>
        {note && (
          <span style={{ fontFamily: FONT, fontSize: '11px', color: '#cbd5e1' }}>{note}</span>
        )}
        {action}
      </span>
    </div>
  );
}

/* ─── Attention card (kept for one-off notices, e.g. QBO reconnect) ── */
// Root is a div, not a button: cards can carry an inline action button
// (nested <button> inside <button> is invalid HTML).
function AttentionCard({ accent, icon: Icon, title, subtitle, onClick }) {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        width: '100%',
        backgroundColor: '#ffffff',
        borderRadius: '10px',
        border: '1px solid #e5e7eb',
        borderLeft: `3px solid ${accent}`,
        padding: '10px 14px',
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'left',
        marginBottom: '6px',
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
      <Icon size={16} style={{ color: accent, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <p
          style={{
            fontFamily: FONT,
            fontSize: '13px',
            fontWeight: 500,
            color: '#0f172a',
            marginBottom: subtitle ? '2px' : 0,
          }}
        >
          {title}
        </p>
        {subtitle && (
          <p style={{ fontFamily: FONT, fontSize: '11px', color: '#94a3b8' }}>{subtitle}</p>
        )}
      </div>
    </div>
  );
}

/* ─── Compact attention row (the dense queue) ──────────────────── */
// One line per issue: icon + title + inline detail + optional action verb.
// Every issue on the page at once — the whole point of the rework.
function AttentionRow({ accent, icon: Icon, title, subtitle, onClick, action }) {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        width: '100%',
        backgroundColor: '#ffffff',
        borderRadius: '8px',
        border: '1px solid #edf0f4',
        borderLeft: `3px solid ${accent}`,
        padding: '6px 12px',
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'left',
        marginBottom: '4px',
        boxSizing: 'border-box',
        transition: 'background-color 0.15s ease',
      }}
      onMouseEnter={(e) => {
        if (onClick) e.currentTarget.style.backgroundColor = '#f8fafc';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = '#ffffff';
      }}
    >
      <Icon size={14} style={{ color: accent, flexShrink: 0 }} />
      <p
        style={{
          fontFamily: FONT,
          fontSize: '13px',
          color: '#0f172a',
          flex: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          margin: 0,
        }}
        title={subtitle ? `${title} — ${subtitle}` : title}
      >
        <span style={{ fontWeight: 500 }}>{title}</span>
        {subtitle && (
          <span style={{ fontSize: '12px', color: '#94a3b8' }}> · {subtitle}</span>
        )}
      </p>
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
            fontSize: '11px',
            fontWeight: 600,
            padding: '3px 9px',
            borderRadius: '6px',
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
        fontSize: '11px',
        fontWeight: 600,
        color: palette.color,
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: '999px',
        padding: '1px 7px',
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
        backgroundColor: '#ffffff',
        borderRadius: '10px',
        border: '1px solid #e5e7eb',
        padding: '12px 14px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.transform = 'translateY(-1px)';
          e.currentTarget.style.boxShadow = '0 6px 18px rgba(56, 189, 248, 0.07)';
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
          marginBottom: '5px',
        }}
      >
        {label}
      </p>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONT, fontSize: '21px', fontWeight: 700, color: '#0f172a' }}>
          {value}
        </span>
        {chip}
      </div>
      {sub && (
        <p style={{ fontFamily: FONT, fontSize: '11px', color: '#94a3b8', marginTop: '3px' }}>
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
        fontSize: '11px',
        fontWeight: 600,
        color: palette.color,
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: '999px',
        padding: '1px 7px',
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
        borderRadius: '10px',
        border: '1px solid #e5e7eb',
        padding: '12px 14px',
        cursor: onClick ? 'pointer' : 'default',
        display: 'flex',
        flexDirection: 'column',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.transform = 'translateY(-1px)';
          e.currentTarget.style.boxShadow = '0 6px 18px rgba(0,0,0,0.05)';
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
          marginBottom: '6px',
        }}
      >
        {title}
      </p>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONT, fontSize: '25px', fontWeight: 700, color: bigColor }}>
          {big}
        </span>
        <span style={{ fontFamily: FONT, fontSize: '12px', color: '#64748b' }}>{unit}</span>
        {pill && (
          <span
            style={{
              fontFamily: FONT,
              fontSize: '11px',
              fontWeight: 600,
              color: '#b91c1c',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '999px',
              padding: '1px 8px',
            }}
          >
            {pill}
          </span>
        )}
        <DeltaChip delta={delta} />
      </div>
      {rows && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {rows}
        </div>
      )}
      <div style={{ flex: 1 }} />
      {footer && (
        <p
          style={{
            fontFamily: FONT,
            fontSize: '11px',
            color: '#64748b',
            marginTop: '10px',
            paddingTop: '8px',
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
      <span style={{ fontFamily: FONT, fontSize: '12px', color: '#64748b' }}>{label}</span>
      <span
        style={{
          fontFamily: FONT,
          fontSize: '12px',
          fontWeight: 600,
          color: '#0f172a',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
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
        fontSize: '11px',
        color: active ? '#0c4a6e' : '#475569',
        backgroundColor: active ? '#e0f2fe' : '#f8fafc',
        border: `1px solid ${active ? '#7dd3fc' : '#e5e7eb'}`,
        borderRadius: '999px',
        padding: '2px 8px',
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
function OverduePanel({ jobs, byService, service, onService, onRow, onWontHappen, total }) {
  const shown = service === 'all' ? jobs : jobs.filter((j) => (j.service || 'Other') === service);
  // Zombie backlog: jobs so late they're almost certainly never happening.
  const backlog = shown.filter((j) => daysLate(j.bm_deadline) >= 180);
  const th = {
    fontFamily: FONT,
    fontSize: '11px',
    fontWeight: 600,
    color: '#475569',
    textAlign: 'left',
    padding: '6px 10px',
    backgroundColor: '#f8fafc',
    whiteSpace: 'nowrap',
  };
  const td = {
    fontFamily: FONT,
    fontSize: '12px',
    color: '#334155',
    padding: '5px 10px',
    borderTop: '1px solid #f1f5f9',
    whiteSpace: 'nowrap',
  };
  return (
    <div
      style={{
        marginTop: '10px',
        backgroundColor: '#ffffff',
        borderRadius: '10px',
        border: '1px solid #e5e7eb',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '5px',
          padding: '10px 12px',
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
        {onWontHappen && backlog.length > 0 && (
          <button
            onClick={() => onWontHappen(backlog)}
            title="Bulk-triage jobs 180+ days late: excludes them from every count and files the BrightManager cleanup on Sophie's admin list"
            style={{
              marginLeft: 'auto', fontFamily: FONT, fontSize: '11px', fontWeight: 600,
              padding: '4px 10px', borderRadius: '7px', border: '1px solid #fcd34d',
              background: '#fef3c7', color: '#92400e', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            Triage backlog — {backlog.length} job{backlog.length === 1 ? '' : 's'} 180d+ late
          </button>
        )}
      </div>
      <div style={{ overflowX: 'auto', maxHeight: '45vh', overflowY: 'auto' }}>
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
              {onWontHappen && <th style={th} aria-label="actions" />}
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
                    maxWidth: '220px',
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
                {onWontHappen && (
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); onWontHappen([j]); }}
                      title="This job is never going to be done — exclude it from every count and file the BrightManager cleanup on Sophie's admin list"
                      style={{
                        fontFamily: FONT, fontSize: '11px', fontWeight: 600,
                        padding: '2px 7px', borderRadius: '6px', border: '1px solid #e5e7eb',
                        background: '#fff', color: '#64748b', cursor: 'pointer', whiteSpace: 'nowrap',
                      }}
                    >
                      Won't happen
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {typeof total === 'number' && total > jobs.length && (
        <div style={{
          padding: '6px 12px', fontFamily: FONT, fontSize: '11px', color: '#92400e',
          background: '#fffbeb', borderTop: '1px solid #fcd34d',
        }}>
          Showing the first {jobs.length} of {total} late jobs — the headline count is exact; use the
          service chips or triage to narrow the list.
        </div>
      )}
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
        minWidth: '130px',
        backgroundColor: '#ffffff',
        borderRadius: '10px',
        border: '1px solid #e5e7eb',
        padding: '10px 14px',
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
          fontSize: '10px',
          fontWeight: 500,
          color: '#94a3b8',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
          marginBottom: '3px',
        }}
      >
        {label}
      </p>
      <p style={{ fontFamily: FONT, fontSize: '18px', fontWeight: 700, color: valueColor }}>
        {value}
        {detail && (
          <span
            style={{ fontSize: '11px', fontWeight: 500, color: '#94a3b8', marginLeft: '6px' }}
          >
            {detail}
          </span>
        )}
      </p>
    </div>
  );
}

/* ─── CH refresh health line (Operations) ──────────────────────── */
// The overnight Companies House sweep is what feeds the strike-off triage —
// so a run that failed or didn't happen is itself an operational signal.
function ChRefreshLine({ run }) {
  let text;
  let tone = 'ok';
  if (!run) {
    text = 'CH refresh last night: did not run';
    tone = 'warn';
  } else {
    const errCount = Array.isArray(run.errors)
      ? run.errors.length
      : run.errors && typeof run.errors === 'object'
        ? Object.keys(run.errors).length
        : 0;
    const companies = run.processed ?? 0;
    const changes = run.status_changes ?? 0;
    text = `CH refresh last night: ${companies} compan${companies === 1 ? 'y' : 'ies'}, ${changes} status change${changes === 1 ? '' : 's'}, ${errCount} error${errCount === 1 ? '' : 's'}`;
    if (errCount > 0) tone = 'warn';
  }
  const dot = tone === 'warn' ? '#f59e0b' : '#22c55e';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        backgroundColor: '#ffffff',
        borderRadius: '10px',
        border: '1px solid #e5e7eb',
        padding: '8px 14px',
        marginTop: '8px',
      }}
    >
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: dot, flexShrink: 0 }} />
      <p style={{ fontFamily: FONT, fontSize: '12px', color: '#475569', margin: 0 }}>{text}</p>
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

// Severity/type groups the dense queue renders under, in display order.
const ATTENTION_GROUPS = [
  { key: 'critical', label: 'Overdue & at risk' },
  { key: 'action', label: 'Ready to action' },
  { key: 'waiting', label: 'Waiting on you' },
  { key: 'requests', label: 'Requests & triage' },
];

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
      group: 'critical',
      accent: '#ef4444',
      icon: AlertTriangle,
      title: `${r.entity?.name || 'Unknown client'} — accounts ${late} day${late === 1 ? '' : 's'} late at Companies House`,
      subtitle: `Due ${shortDate(r.bm_deadline)} · ${bmStatus(r.bm_status)}${owner}`,
      onClick: () => (r.entity?.id ? navigate(`/clients/${r.entity.id}`) : navigate('/planner/ready?service=Acc&due=overdue')),
      // Payload for the inline "Raise chase task" verb — kept as plain data so
      // this builder stays pure; the row wires it to the insert.
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
      group: 'critical',
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
      group: 'critical',
      accent: '#ef4444',
      icon: AlertTriangle,
      title: `${plural(data.sa.overdueList.length, 'Self Assessment return')} past the filing deadline`,
      subtitle: names + (data.sa.overdueList.length > 3 ? '…' : ''),
      onClick: () => navigate('/planner/ready?service=SA&due=overdue'),
    });
  }

  // Triage: strike-off risk is critical (CH status changed under us); the
  // rest are visibility items. All resolve on the triage page.
  (data.triage || []).forEach((t) => {
    const name = t.entity?.name || 'Unknown client';
    if (t.category === 'strike_off') {
      items.push({
        id: `triage-${t.id}`,
        group: 'critical',
        accent: '#ef4444',
        icon: AlertTriangle,
        title: `${name} — strike-off risk (Companies House status changed)`,
        subtitle: 'Resolve in triage',
        onClick: () => navigate('/triage'),
      });
    } else {
      items.push({
        id: `triage-${t.id}`,
        group: 'requests',
        accent: '#38bdf8',
        icon: Inbox,
        title: t.category === 'on_hold' ? `${name} — on hold` : `${name} — in triage`,
        subtitle: 'Open triage',
        onClick: () => navigate('/triage'),
      });
    }
  });

  // Bookkeeping drift. Only files we keep, and only ones already past
  // tolerance — the board itself carries the watch and breach detail. Rows name
  // the frontier and the gap, because "X is drifting" tells nobody what to do.
  const drift = data.drift || { ours: [], priority: [], unknown: [], theirsCount: 0 };
  const driftAction = drift.ours.filter((r) => r.drift_status !== 'unknown');
  driftAction.slice(0, 6).forEach((r) => {
    const frontier = r.frontier_basis === 'posted' ? r.posted_to : r.reconciled_to;
    const isPriority = r.tier !== 'standard';
    items.push({
      id: `drift-${r.entity_id}`,
      group: r.drift_status === 'critical' || isPriority ? 'critical' : 'action',
      accent: r.drift_status === 'critical' || isPriority ? '#ef4444' : '#f97316',
      icon: AlertTriangle,
      title: `${r.entity_name} — books ${r.frontier_basis === 'posted' ? 'posted' : 'reconciled'} only to ${
        frontier ? shortDate(frontier) : 'nothing in six months'}`,
      subtitle: `${r.days_over_tolerance} days past tolerance${
        isPriority ? ' · never-drift client' : ''}${
        r.assignee_name ? ` · ${r.assignee_name.split(' ')[0]}` : ' · unassigned'}${
        r.case_state === 'acknowledged' ? ' · acknowledged' : ''}`,
      onClick: () => navigate('/planner/bookkeeping-health'),
    });
  });
  if (driftAction.length > 6) {
    items.push({
      id: 'drift-more',
      group: 'action',
      accent: '#f97316',
      icon: AlertTriangle,
      title: `${plural(driftAction.length - 6, 'more client')} with bookkeeping past tolerance`,
      subtitle: 'Open the drifting board for the full list',
      onClick: () => navigate('/planner/bookkeeping-health'),
    });
  }
  // A file the sweep couldn't read is not a healthy file. It gets its own row
  // rather than quietly vanishing from the counts.
  if (drift.unknown.length > 0) {
    items.push({
      id: 'drift-unknown',
      group: 'waiting',
      accent: '#8b5cf6',
      icon: AlertTriangle,
      title: `${plural(drift.unknown.length, 'QuickBooks file')} couldn't be read last night`,
      subtitle: 'Drift is unknown for these — usually a connection that needs re-authorising',
      onClick: () => navigate('/planner/bookkeeping-health'),
    });
  }

  data.onboarding.issues.forEach((o) => {
    items.push({
      id: `onb-${o.id}`,
      group: 'critical',
      accent: '#ef4444',
      icon: AlertTriangle,
      title: `${o.entity?.name || 'Onboarding'} — flagged with issues`,
      subtitle: 'Onboarding needs unblocking',
      onClick: () => navigate('/onboarding'),
    });
  });

  data.quotes.expiring.forEach((q) => {
    items.push({
      id: `exp-${q.id}`,
      group: 'critical',
      accent: '#f87171',
      icon: AlertTriangle,
      title: `${q.relationship_group || q.quote_ref} — accepted quote expires ${shortDate(
        q.valid_until,
      )}`,
      subtitle: q.quote_ref,
      onClick: () => navigate(`/manage/quotes/${q.id}`),
    });
  });

  data.quotes.accepted.forEach((q) => {
    items.push({
      id: `acc-${q.id}`,
      group: 'action',
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
      group: 'waiting',
      accent: '#f59e0b',
      icon: Clock,
      title: `${q.relationship_group || q.quote_ref} — quote awaiting approval`,
      subtitle: q.quote_ref,
      onClick: () => navigate(`/manage/quotes/${q.id}`),
    });
  });

  if (data.billingNeedsReview > 0) {
    items.push({
      id: 'billing-review',
      group: 'waiting',
      accent: '#f59e0b',
      icon: Clock,
      title: `${plural(data.billingNeedsReview, 'live billing record')} flagged for review`,
      subtitle: 'Billing review',
      onClick: () => navigate('/manage/billing/review'),
    });
  }

  // Clients doing chargeable work with no fee mapped in the engine. Only the
  // priority tier (companies + recurring services) reaches the queue; the
  // noisy SA-individual tail lives on the review page. Count is 0 for non-fee
  // viewers (RLS), so this row simply doesn't appear for them.
  if (data.feeGaps?.priority > 0) {
    items.push({
      id: 'fee-gaps',
      group: 'waiting',
      accent: '#f59e0b',
      icon: Clock,
      title: `${plural(data.feeGaps.priority, 'client')} doing work with no fee mapped`,
      subtitle: 'Companies & recurring services — set up fees in the engine',
      onClick: () => navigate('/manage/billing/gaps'),
    });
  }

  // QBO customers the nightly ~5am pull found with no client mapping yet.
  if (data.qboUnmapped > 0) {
    items.push({
      id: 'qbo-mapping',
      group: 'waiting',
      accent: '#f59e0b',
      icon: Clock,
      title: `${plural(data.qboUnmapped, 'QuickBooks customer')} need${data.qboUnmapped === 1 ? 's' : ''} mapping`,
      subtitle: 'From the nightly QBO pull — map to clients',
      onClick: () => navigate('/manage/billing/qbo-mapping'),
    });
  }

  data.serviceRequests.forEach((r) => {
    items.push({
      id: `sr-${r.id}`,
      group: 'requests',
      accent: '#38bdf8',
      icon: Inbox,
      title: `${r.entity?.name || 'A client'} requested ${r.service_title || 'a new service'} via the portal`,
      subtitle: `Raised ${shortDate(r.created_at)} — respond with a quote`,
      // The row's own copy says the remedy is a quote — link to the quote form.
      onClick: () => (r.entity_id ? navigate(`/manage/quotes/new?entity=${r.entity_id}`) : navigate('/onboarding')),
    });
  });

  return items;
}

// One-line summary chips — counts by kind, worst first. Shown collapsed AND
// as the chip row above the expanded queue.
function attentionSummary(data) {
  const seg = [];
  const p = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;
  const strikeOff = (data.triage || []).filter((t) => t.category === 'strike_off').length;
  const otherTriage = (data.triage || []).length - strikeOff;
  if (data.ch.overdue > 0) seg.push(`${p(data.ch.overdue, 'CH filing')} late`);
  if (data.sa.overdueList.length > 0) seg.push(`${p(data.sa.overdueList.length, 'SA return')} late`);
  if (strikeOff > 0) seg.push(p(strikeOff, 'strike-off risk'));
  if (data.onboarding.issues.length > 0) seg.push(p(data.onboarding.issues.length, 'onboarding issue'));
  if (data.quotes.accepted.length > 0) seg.push(`${p(data.quotes.accepted.length, 'quote')} to commit`);
  if (data.quotes.pendingApproval.length > 0) seg.push(`${p(data.quotes.pendingApproval.length, 'approval')} waiting`);
  if (data.quotes.expiring.length > 0) seg.push(`${p(data.quotes.expiring.length, 'quote')} expiring`);
  if (data.billingNeedsReview > 0) seg.push(p(data.billingNeedsReview, 'billing review'));
  const driftOurs = (data.drift?.ours || []).filter((r) => r.drift_status !== 'unknown').length;
  if (driftOurs > 0) seg.push(`${p(driftOurs, 'client')} drifting`);
  if (data.feeGaps?.priority > 0) seg.push(`${data.feeGaps.priority} fee gap${data.feeGaps.priority === 1 ? '' : 's'}`);
  if (data.qboUnmapped > 0) seg.push(`${data.qboUnmapped} QBO unmapped`);
  if (data.serviceRequests.length > 0) seg.push(p(data.serviceRequests.length, 'service request'));
  if (otherTriage > 0) seg.push(p(otherTriage, 'triage case'));
  return seg;
}

/* ─── Summary chip (top of the queue, and the collapsed card) ──── */
function SummaryChip({ children }) {
  return (
    <span
      style={{
        fontFamily: FONT,
        fontSize: '11px',
        fontWeight: 500,
        color: '#475569',
        backgroundColor: '#f8fafc',
        border: '1px solid #e5e7eb',
        borderRadius: '999px',
        padding: '2px 9px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
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
        gap: '12px',
        width: '100%',
        backgroundColor: '#ffffff',
        borderRadius: '10px',
        border: '1px solid #e5e7eb',
        borderLeft: `3px solid ${accent}`,
        padding: '10px 14px',
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
      <Icon size={16} style={{ color: accent, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <p
          style={{
            fontFamily: FONT,
            fontSize: '13px',
            fontWeight: 500,
            color: '#0f172a',
            marginBottom: '2px',
          }}
        >
          {items.length} item{items.length === 1 ? '' : 's'} need{items.length === 1 ? 's' : ''} your
          attention
        </p>
        <p style={{ fontFamily: FONT, fontSize: '11px', color: '#94a3b8' }}>
          {segments.join(' · ')}
        </p>
      </div>
      <ChevronDown size={16} style={{ color: '#94a3b8', flexShrink: 0 }} />
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
  // Fee-engine gaps are confidential (the view reads live_billing) — only fee
  // admins get a real count, so only they see the counter tile.
  const canViewFees = profile?.can_view_client_fees === true;

  const { loading, data } = useDirectorDashboard(isOwner || canSeeAttention);
  const { loading: pulseLoading, pulse, error: pulseError } = usePracticePulse(canSeePulse);

  // The queue starts COLLAPSED (a one-line summary); click to expand the full
  // list. It sits mid-page now rather than dominating the top.
  const [attentionOpen, setAttentionOpen] = useState(false);
  const attentionToggledRef = useRef(false);
  const attentionRef = useRef(null);

  // Practice-pulse period: fiscal YTD, or the last 12 complete months.
  const [pulsePeriod, setPulsePeriod] = useState('fytd'); // 'fytd' | 'ltm'
  const collapseAttention = () => {
    attentionToggledRef.current = true;
    setAttentionOpen(false);
    requestAnimationFrame(() =>
      attentionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };
  const expandAttention = () => {
    attentionToggledRef.current = true;
    setAttentionOpen(true);
  };

  // The 86-late-jobs list lives here, not in the planner — Ready Now only
  // covers SA/AA by design, so overdue VAT/payroll/etc have no page of their own.
  const [overdueOpen, setOverdueOpen] = useState(false);
  const [overdueService, setOverdueService] = useState('all');

  // Inline verb on late-filing rows: one click creates a chase task in the
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

  // "Won't happen" triage: exclude zombie jobs from every count and file the
  // BM cleanup on Sophie's admin list (auto-confirmed when the job leaves the
  // next BM export). Owner-only — the RPC enforces can_manage_portal too.
  const [wontHappenIds, setWontHappenIds] = useState(() => new Set());
  const markWontHappen = async (jobsToMark) => {
    const names = jobsToMark.slice(0, 6).map((j) => `• ${j.entity?.name || '?'} — ${j.bm_task_name}`).join('\n');
    const more = jobsToMark.length > 6 ? `\n…and ${jobsToMark.length - 6} more` : '';
    if (!window.confirm(
      `Mark ${jobsToMark.length} job${jobsToMark.length === 1 ? '' : 's'} as "won't happen"?\n\n${names}${more}\n\nThey leave every count now; Sophie gets one BrightManager cleanup task each. Nothing is deleted.`,
    )) return;
    const reason = window.prompt('Why won\'t this happen? (optional — goes on Sophie\'s task)', '');
    if (reason === null) return;
    const { data: res, error } = await supabase.rpc('mark_bm_tasks_wont_happen', {
      p_ids: jobsToMark.map((j) => j.id),
      p_reason: reason || null,
    });
    if (error) { alert('Could not mark: ' + error.message); return; }
    setWontHappenIds((prev) => {
      const next = new Set(prev);
      jobsToMark.forEach((j) => next.add(j.id));
      return next;
    });
    if (res?.marked != null) console.info(`[HomeScreen] won't-happen: ${res.marked} marked, ${res.admin_tasks_created} admin tasks filed`);
  };

  // Jobs marked this session disappear immediately (the next load excludes
  // them server-side); the headline count follows.
  const visibleOverdueJobs = (data?.overdueWork.jobs || []).filter((j) => !wontHappenIds.has(j.id));
  const visibleOverdueTotal = Math.max(0, (data?.overdueWork.total || 0) - wontHappenIds.size);

  const attentionItems = data ? buildAttentionItems(data, navigate) : [];
  const attentionGroups = ATTENTION_GROUPS.map((g) => ({
    ...g,
    items: attentionItems.filter((i) => (i.group || 'waiting') === g.key),
  })).filter((g) => g.items.length > 0);

  // Staff (non-owner) keep the module strip as their orientation aid.
  const visibleModules = MODULES.filter((mod) => {
    if (mod.status !== 'live') return false;
    if (!mod.permissions || mod.permissions.length === 0) return true;
    return mod.permissions.every((p) => profile?.[p] === true);
  });

  const bmNote = data?.bmDataAsOf
    ? `work data from BrightManager · refreshed ${shortDate(data.bmDataAsOf)}`
    : null;

  /* ── Section renderers ── */

  const attentionSection = canSeeAttention && (
    <div ref={attentionRef} style={{ scrollMarginTop: '20px' }}>
      <SectionLabel
        action={
          !loading && attentionItems.length > 0 ? (
            <button
              onClick={() => (attentionOpen ? collapseAttention() : expandAttention())}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontFamily: FONT,
                fontSize: '11px',
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
                  Collapse <ChevronUp size={13} />
                </>
              ) : (
                <>
                  Show all {attentionItems.length} <ChevronDown size={13} />
                </>
              )}
            </button>
          ) : null
        }
      >
        Needs attention{!loading && attentionItems.length > 0 ? ` — ${attentionItems.length}` : ''}
      </SectionLabel>
      {loading ? (
        <p style={{ fontFamily: FONT, fontSize: '12px', color: '#94a3b8' }}>Checking…</p>
      ) : attentionItems.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            backgroundColor: '#ffffff',
            borderRadius: '10px',
            border: '1px solid #e5e7eb',
            borderLeft: '3px solid #22c55e',
            padding: '10px 14px',
          }}
        >
          <CheckCircle size={16} style={{ color: '#22c55e', flexShrink: 0 }} />
          <p style={{ fontFamily: FONT, fontSize: '13px', fontWeight: 500, color: '#0f172a' }}>
            Nothing needs your attention right now.
          </p>
        </div>
      ) : !attentionOpen ? (
        <AttentionSummaryCard
          items={attentionItems}
          segments={attentionSummary(data)}
          onExpand={expandAttention}
        />
      ) : (
        <>
          {/* Summary chip row stays on top so the shape of the queue is
              readable before the detail. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' }}>
            {attentionSummary(data).map((s) => (
              <SummaryChip key={s}>{s}</SummaryChip>
            ))}
          </div>
          {/* Every item, no cap — dense rows in a scrollable well. */}
          <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: '2px' }}>
            {attentionGroups.map((g) => (
              <div key={g.key} style={{ marginBottom: '8px' }}>
                <p
                  style={{
                    fontFamily: FONT,
                    fontSize: '10px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: '#94a3b8',
                    margin: '0 0 4px 2px',
                  }}
                >
                  {g.label} · {g.items.length}
                </p>
                {g.items.map((item) => (
                  <AttentionRow
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
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );

  // Each pulse figure deep-links straight through to AVA's matching report tab
  // on the Client Dashboard (revenue/profit → P&L, cash → balance sheet,
  // debtors → debtors & creditors), not just the dashboard landing.
  const openPulse = (tab) =>
    navigate(
      pulse?.realmId
        ? `/client-dashboard?realm=${encodeURIComponent(pulse.realmId)}&tab=${tab}`
        : '/client-dashboard',
    );

  const pulseIsLtm = pulsePeriod === 'ltm';
  const pulsePl = pulseIsLtm ? pulse?.plSummary : pulse?.plFytd;
  const pulsePeriodLabel = pulseIsLtm ? 'last 12 months' : 'fiscal YTD';
  const pulseToggle = (
    <span style={{ display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: '999px', overflow: 'hidden' }}>
      {[['fytd', 'Fiscal YTD'], ['ltm', 'Last 12 months']].map(([key, label]) => (
        <button
          key={key}
          onClick={() => setPulsePeriod(key)}
          style={{
            fontFamily: FONT, fontSize: '11px', fontWeight: 600, padding: '3px 10px',
            border: 'none', cursor: 'pointer',
            backgroundColor: pulsePeriod === key ? '#0f172a' : '#ffffff',
            color: pulsePeriod === key ? '#ffffff' : '#64748b',
          }}
        >
          {label}
        </button>
      ))}
    </span>
  );

  const pulseSection = canSeePulse && (
    <div>
      <SectionLabel
        note={
          pulse?.pulledAt
            ? `QuickBooks · ${pulse.fromCache ? 'cached ' : 'pulled '}${shortDate(pulse.pulledAt)} · only you`
            : 'visible only to you'
        }
        action={!pulseLoading && pulseError !== 'reconnect' && pulseError !== 'no-connection' ? pulseToggle : null}
      >
        Practice pulse
      </SectionLabel>
      {pulseLoading ? (
        <p style={{ fontFamily: FONT, fontSize: '12px', color: '#94a3b8' }}>
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
        // One row, tiles sized equally across the page (scrolls if it ever
        // outgrows the width — room to add more tiles here later).
        <div
          style={{
            display: 'grid',
            gridAutoFlow: 'column',
            gridAutoColumns: 'minmax(0, 1fr)',
            gap: '10px',
            overflowX: 'auto',
          }}
        >
          <StatCard
            label={`Revenue — ${pulsePeriodLabel}`}
            value={pulsePl?.income != null ? formatCurrency(pulsePl.income) : '—'}
            chip={pulseIsLtm ? null : <YoYChip current={pulse?.plFytd?.income} prior={pulse?.plFytdPrior?.income} />}
            sub={
              pulseIsLtm
                ? (pulsePl?.period ? `${shortDate(pulsePl.period.start)} – ${shortDate(pulsePl.period.end)}` : null)
                : [
                    pulse?.plFytd?.period?.start ? `since ${shortDate(pulse.plFytd.period.start)}` : null,
                    pulse?.plFytdPrior?.income != null ? `${formatCurrency(pulse.plFytdPrior.income)} last year` : null,
                  ].filter(Boolean).join(' · ')
            }
            onClick={() => openPulse('pnl')}
          />
          <StatCard
            label={`Net operating — ${pulsePeriodLabel}`}
            value={pulsePl?.net_operating_income != null ? formatCurrency(pulsePl.net_operating_income) : '—'}
            chip={pulseIsLtm ? null : <YoYChip current={pulse?.plFytd?.net_operating_income} prior={pulse?.plFytdPrior?.net_operating_income} />}
            sub={[
              pulsePl?.net_operating_income != null && pulsePl?.income > 0
                ? `${Math.round((pulsePl.net_operating_income / pulsePl.income) * 100)}% margin`
                : null,
              pulsePl?.net_income != null ? `${formatCurrency(pulsePl.net_income)} net after dividends` : null,
            ].filter(Boolean).join(' · ')}
            onClick={() => openPulse('pnl')}
          />
          <StatCard
            label="Cash at bank"
            value={pulse?.balances?.cash != null ? formatCurrency(pulse.balances.cash) : '—'}
            sub={
              pulse?.balances?.bank_account_count
                ? `across ${pulse.balances.bank_account_count} bank account${pulse.balances.bank_account_count === 1 ? '' : 's'}`
                : null
            }
            onClick={() => openPulse('balance')}
          />
          <StatCard
            label="Debtors"
            value={pulse?.balances?.debtors != null ? formatCurrency(pulse.balances.debtors) : '—'}
            sub="owed to the practice"
            onClick={() => openPulse('aged')}
          />
        </div>
      )}
    </div>
  );

  const deadlinesSection = isOwner && data && (
    <div>
      <SectionLabel
        note={[bmNote, data.wow ? `▲▼ vs digest ${shortDate(data.wow.since)}` : null]
          .filter(Boolean)
          .join(' · ')}
      >
        Deadlines
      </SectionLabel>
      {/* Compact, drillable tiles — click through to the planner; no inline
          detail panels. */}
      <div
        style={{
          display: 'grid',
          gridAutoFlow: 'column',
          gridAutoColumns: 'minmax(0, 1fr)',
          gap: '10px',
          overflowX: 'auto',
        }}
      >
        <OpsStat
          label={`CH accounts · ${thisMonthName}`}
          value={data.ch.thisMonth}
          detail={data.ch.overdue > 0 ? `${data.ch.overdue} past deadline` : 'due this month'}
          tone={data.ch.overdue > 0 ? 'warn' : 'default'}
          onClick={() => navigate('/planner/ready?service=Acc')}
        />
        <OpsStat
          label="CH accounts · next 6 months"
          value={data.ch.sixMonths}
          detail="filings due"
          onClick={() => navigate('/planner/ready?service=Acc')}
        />
        <OpsStat
          label={`Self Assessment · 31 Jan ${data.sa.year}`}
          value={data.sa.count}
          detail="returns due"
          onClick={() => navigate('/planner/ready?service=SA')}
        />
        <OpsStat
          label="Work past BM deadline"
          value={visibleOverdueTotal}
          detail="late jobs"
          tone={visibleOverdueTotal > 0 ? 'bad' : 'default'}
          onClick={() => navigate('/planner/ready')}
        />
      </div>
    </div>
  );

  const opsSection = isOwner && data && (
    <div>
      <SectionLabel>Operations</SectionLabel>
      <JobReviewRadar />
      {/* Last night's Companies House sweep — the feed behind strike-off triage. */}
      <ChRefreshLine run={data.chRefresh} />
    </div>
  );

  // Task counters — onboardings, CH codes, admin tasks, issues log, triage.
  const strikeOffCount = (data?.triage || []).filter((t) => t.category === 'strike_off').length;
  const triageCount = (data?.triage || []).length;
  const countersSection = isOwner && data && (
    <div>
      <SectionLabel>Task counters</SectionLabel>
      <div
        style={{
          display: 'grid',
          gridAutoFlow: 'column',
          gridAutoColumns: 'minmax(0, 1fr)',
          gap: '8px',
          overflowX: 'auto',
        }}
      >
        <OpsStat
          label="Onboardings"
          value={data.onboarding.inFlight}
          detail={data.onboarding.issues.length > 0 ? `${data.onboarding.issues.length} with issues` : 'in flight'}
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
          onClick={() => navigate('/planner/tasks')}
        />
        <OpsStat
          label="Issues log"
          value={data.issuesOpen}
          detail="open"
          tone={data.issuesOpen > 0 ? 'warn' : 'default'}
          onClick={() => navigate('/issues')}
        />
        <OpsStat
          label="Triage"
          value={triageCount}
          detail={strikeOffCount > 0 ? `${strikeOffCount} strike-off` : 'open cases'}
          tone={strikeOffCount > 0 ? 'bad' : triageCount > 0 ? 'warn' : 'default'}
          onClick={() => navigate('/triage')}
        />
        {canViewFees && (
          <OpsStat
            label="Fee engine gaps"
            value={data.feeGaps?.priority ?? 0}
            detail={
              data.feeGaps?.individuals
                ? `+${data.feeGaps.individuals} individuals`
                : 'work with no fee'
            }
            tone={data.feeGaps?.priority > 0 ? 'bad' : 'default'}
            onClick={() => navigate('/manage/billing/gaps')}
          />
        )}
      </div>
    </div>
  );

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '24px 24px 40px' }}>
      {/* ── Header row ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: '20px',
        }}
      >
        <h1
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: '25px',
            fontWeight: 500,
            color: '#0f172a',
          }}
        >
          {getGreeting()}, {firstName}
        </h1>
        <span style={{ fontFamily: FONT, fontSize: '12px', color: '#94a3b8' }}>
          {formatDate()}
        </span>
      </div>

      {/* ── Full-width stacked sections: deadlines, operations, needs
             attention (collapsed), practice pulse, then task counters. ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {deadlinesSection}
        {opsSection}
        {attentionSection}
        {pulseSection}
        {countersSection}
      </div>

      {/* ── Module strip (staff orientation — owners know the sidebar) ── */}
      {!isOwner && (
        <div style={{ marginTop: canSeeAttention ? '24px' : 0 }}>
          <SectionLabel>Modules</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px 18px', alignItems: 'center' }}>
            {visibleModules.map((mod) => (
              <div key={mod.id} style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
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
