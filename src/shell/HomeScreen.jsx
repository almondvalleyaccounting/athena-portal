import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Clock, CheckCircle, CheckCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { MODULES } from '../modules.config';
import { useAuth } from './AppShell';

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

function startOfWeek() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(d);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

function threeDaysFromNow() {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d.toISOString();
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

/* ─── Data hooks ───────────────────────────────────────────────── */
function useAwaitingReview(enabled) {
  // Accepted quotes that haven't been committed to Live yet. These are
  // Bobby's post-client-accept review queue ahead of pushing to QBO.
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const { data } = await supabase
          .from('quotes')
          .select(
            'id, quote_ref, relationship_group, accepted_at, monthly_gross, annual_total',
          )
          .eq('status', 'accepted')
          .order('accepted_at', { ascending: false })
          .limit(10);

        setItems(
          (data || []).map((q) => ({
            id: q.id,
            quote_ref: q.quote_ref,
            client: q.relationship_group || q.quote_ref,
            accepted_at: q.accepted_at,
            monthly_gross: q.monthly_gross,
            annual_total: q.annual_total,
            onClick: () => navigate(`/manage/quotes/${q.id}`),
          })),
        );
      } catch {
        setItems([]);
      }
      setLoading(false);
    })();
  }, [enabled, navigate]);

  return { items, loading };
}

function useAttentionItems(enabled) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    (async () => {
      try {
        // Quotes awaiting approval
        const { data: pending } = await supabase
          .from('quotes')
          .select('id, quote_ref, relationship_group, created_at, status')
          .in('status', ['pending_approval', 'awaiting_approval'])
          .order('created_at', { ascending: false })
          .limit(10);

        // Accepted quotes expiring within 3 days
        const { data: expiring } = await supabase
          .from('quotes')
          .select('id, quote_ref, relationship_group, valid_until, status')
          .eq('status', 'accepted')
          .not('valid_until', 'is', null)
          .lte('valid_until', threeDaysFromNow())
          .gte('valid_until', new Date().toISOString())
          .order('valid_until', { ascending: true })
          .limit(10);

        const result = [];

        (pending || []).forEach((q) => {
          result.push({
            id: q.id,
            accent: '#f59e0b', // amber
            icon: Clock,
            title: `${q.relationship_group || q.quote_ref} — awaiting approval`,
            subtitle: q.quote_ref,
            onClick: () => navigate('/manage'),
          });
        });

        (expiring || []).forEach((q) => {
          const expiryDate = new Date(q.valid_until).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
          });
          result.push({
            id: q.id,
            accent: '#f87171', // red
            icon: AlertTriangle,
            title: `${q.relationship_group || q.quote_ref} — expires ${expiryDate}`,
            subtitle: q.quote_ref,
            onClick: () => navigate('/manage'),
          });
        });

        setItems(result);
      } catch {
        setItems([]);
      }
      setLoading(false);
    })();
  }, [enabled, navigate]);

  return { items, loading };
}

function useWeeklyStats(enabled) {
  const [stats, setStats] = useState({
    feesCommitted: null,
    quotesCreated: null,
    awaitingApproval: null,
  });

  useEffect(() => {
    if (!enabled) return;

    (async () => {
      const weekStart = startOfWeek();

      try {
        // Fees committed this week — live_billing records created this week
        const { data: billing } = await supabase
          .from('live_billing')
          .select('monthly_fee')
          .gte('created_at', weekStart);

        const totalFees = (billing || []).reduce(
          (sum, r) => sum + (r.monthly_fee || 0) * 12,
          0
        );

        // Quotes created this week
        const { count: quotesCount } = await supabase
          .from('quotes')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', weekStart);

        // Quotes awaiting approval (all time)
        const { count: awaitingCount } = await supabase
          .from('quotes')
          .select('id', { count: 'exact', head: true })
          .in('status', ['pending_approval', 'awaiting_approval']);

        setStats({
          feesCommitted: totalFees,
          quotesCreated: quotesCount ?? 0,
          awaitingApproval: awaitingCount ?? 0,
        });
      } catch {
        // Leave as null on error — UI shows —
      }
    })();
  }, [enabled]);

  return stats;
}

/* ─── Section label ────────────────────────────────────────────── */
function SectionLabel({ children }) {
  return (
    <h2
      style={{
        fontFamily: "'Outfit', sans-serif",
        fontSize: '13px',
        fontWeight: 600,
        textTransform: 'uppercase',
        color: '#94a3b8',
        letterSpacing: '0.04em',
        marginBottom: '16px',
      }}
    >
      {children}
    </h2>
  );
}

/* ─── Attention card ───────────────────────────────────────────── */
function AttentionCard({ accent, icon: Icon, title, subtitle, onClick }) {
  return (
    <button
      onClick={onClick}
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
            fontFamily: "'Outfit', sans-serif",
            fontSize: '14px',
            fontWeight: 500,
            color: '#0f172a',
            marginBottom: '2px',
          }}
        >
          {title}
        </p>
        {subtitle && (
          <p
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '12px',
              color: '#94a3b8',
            }}
          >
            {subtitle}
          </p>
        )}
      </div>
    </button>
  );
}

/* ─── Review card (accepted quotes awaiting review) ─────────────── */
function ReviewCard({ quote_ref, client, accepted_at, monthly_gross, annual_total, onClick }) {
  const acceptedLabel = accepted_at
    ? new Date(accepted_at).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
      })
    : '';
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        width: '100%',
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        borderLeft: '3px solid #22c55e',
        padding: '14px 18px',
        cursor: 'pointer',
        textAlign: 'left',
        marginBottom: '8px',
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
      <CheckCheck size={18} style={{ color: '#22c55e', flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <p
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '14px',
            fontWeight: 500,
            color: '#0f172a',
            marginBottom: '2px',
          }}
        >
          {client} accepted {quote_ref}
          {acceptedLabel && (
            <span style={{ color: '#94a3b8', fontWeight: 400 }}>
              {' — '}
              {acceptedLabel}
            </span>
          )}
        </p>
        <p
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '12px',
            color: '#94a3b8',
          }}
        >
          {formatCurrency2dp(monthly_gross || 0)}/mo · {formatCurrency2dp(annual_total || 0)}/yr inc VAT · Push to QBO
        </p>
      </div>
    </button>
  );
}

/* ─── Stat card ────────────────────────────────────────────────── */
function StatCard({ label, value, onClick }) {
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
          fontFamily: "'Outfit', sans-serif",
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
      <p
        style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: '28px',
          fontWeight: 700,
          color: '#0f172a',
        }}
      >
        {value}
      </p>
    </div>
  );
}

/* ─── Module status dot ────────────────────────────────────────── */
function ModuleStatusDot({ mod }) {
  const dotStyle = {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
  };

  if (mod.status === 'live') {
    return <span style={{ ...dotStyle, backgroundColor: '#38bdf8' }} />;
  }
  if (mod.status === 'beta') {
    return <span style={{ ...dotStyle, backgroundColor: '#f59e0b' }} />;
  }
  // planned
  return (
    <span
      style={{
        ...dotStyle,
        backgroundColor: 'transparent',
        border: '1.5px solid #94a3b8',
      }}
    />
  );
}

/* ─── HomeScreen ───────────────────────────────────────────────── */
export default function HomeScreen() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  const firstName = profile?.name?.split(' ')[0] || 'there';
  const isOwner = profile?.can_manage_portal === true;
  const isManager = false;
  const canSeeAttention = profile?.can_approve_quotes === true || isManager;
  const canSeeStats = isOwner || isManager;

  // Live data
  const { items: reviewItems, loading: reviewLoading } =
    useAwaitingReview(canSeeAttention);
  const { items: attentionItems, loading: attentionLoading } =
    useAttentionItems(canSeeAttention);
  const stats = useWeeklyStats(canSeeStats);

  // Determine which modules the user can see in the status strip
  const visibleModules = MODULES.filter((mod) => {
    if (mod.status === 'live') {
      if (!mod.permissions || mod.permissions.length === 0) return true;
      return mod.permissions.every((p) => profile?.[p] === true);
    }
    if (mod.status === 'planned') {
      return isOwner || isManager;
    }
    return false;
  });

  // If owner, show ALL modules in status strip
  const statusModules = isOwner ? MODULES : visibleModules;

  // Show max 5 attention items
  const displayItems = attentionItems.slice(0, 5);
  const hasMore = attentionItems.length > 5;

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
        <span
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '13px',
            color: '#94a3b8',
          }}
        >
          {formatDate()}
        </span>
      </div>

      {/* ── Awaiting review (Bobby + Tracy only — accepted, not yet committed) ── */}
      {canSeeAttention && !reviewLoading && reviewItems.length > 0 && (
        <div style={{ marginBottom: '36px' }}>
          <SectionLabel>Awaiting review</SectionLabel>
          {reviewItems.slice(0, 5).map((item) => (
            <ReviewCard
              key={item.id}
              quote_ref={item.quote_ref}
              client={item.client}
              accepted_at={item.accepted_at}
              monthly_gross={item.monthly_gross}
              annual_total={item.annual_total}
              onClick={item.onClick}
            />
          ))}
          {reviewItems.length > 5 && (
            <button
              onClick={() => navigate('/manage/quotes')}
              style={{
                fontFamily: "'Outfit', sans-serif",
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
              View all {reviewItems.length} accepted &rarr;
            </button>
          )}
        </div>
      )}

      {/* ── Needs attention (Bobby + Tracy only) ── */}
      {canSeeAttention && (
        <div style={{ marginBottom: '36px' }}>
          <SectionLabel>Needs attention</SectionLabel>

          {attentionLoading ? (
            <p
              style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: '13px',
                color: '#94a3b8',
              }}
            >
              Checking...
            </p>
          ) : displayItems.length === 0 ? (
            /* All-clear state */
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
              <p
                style={{
                  fontFamily: "'Outfit', sans-serif",
                  fontSize: '14px',
                  fontWeight: 500,
                  color: '#0f172a',
                }}
              >
                Nothing needs your attention right now.
              </p>
            </div>
          ) : (
            <>
              {displayItems.map((item) => (
                <AttentionCard
                  key={item.id}
                  accent={item.accent}
                  icon={item.icon}
                  title={item.title}
                  subtitle={item.subtitle}
                  onClick={item.onClick}
                />
              ))}
              {hasMore && (
                <button
                  onClick={() => navigate('/manage')}
                  style={{
                    fontFamily: "'Outfit', sans-serif",
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
                  View all {attentionItems.length} pending &rarr;
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Stats row (Bobby + Tracy only) ── */}
      {canSeeStats && (
        <div style={{ marginBottom: '36px' }}>
          <SectionLabel>This week</SectionLabel>
          <div style={{ display: 'flex', gap: '16px' }}>
            <StatCard
              label="Fees committed"
              value={
                stats.feesCommitted !== null
                  ? formatCurrency(stats.feesCommitted)
                  : '—'
              }
            />
            <StatCard
              label="Quotes created"
              value={stats.quotesCreated !== null ? stats.quotesCreated : '—'}
            />
            <StatCard
              label="Awaiting approval"
              value={
                stats.awaitingApproval !== null ? stats.awaitingApproval : '—'
              }
              onClick={() => navigate('/manage')}
            />
          </div>
        </div>
      )}

      {/* ── Module status strip ── */}
      <div>
        <SectionLabel>Modules</SectionLabel>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '20px',
            alignItems: 'center',
          }}
        >
          {statusModules.map((mod) => (
            <div
              key={mod.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <ModuleStatusDot mod={mod} />
              <span
                style={{
                  fontFamily: "'Outfit', sans-serif",
                  fontSize: '13px',
                  fontWeight: 500,
                  color: mod.status === 'planned' ? '#94a3b8' : '#1e293b',
                }}
              >
                {mod.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
