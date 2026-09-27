import React from 'react';
import {
  FileText, Calculator, Receipt, Landmark, Users, PiggyBank, Wallet, BarChart3, LineChart, TrendingUp,
  Target, Briefcase, Building2, ShieldCheck, ClipboardCheck, CalendarCheck, BookOpen, Coins, Banknote,
  Scale, Handshake, Lightbulb, Home, Fingerprint, Send, MessagesSquare, Compass, FileSpreadsheet,
  UserCheck, Mail, Stamp, Presentation, Rocket, Sparkles, Check, X, Plus,
} from 'lucide-react';
import { ACCENTS } from './packContent';

// One A4 page of a proposal pack, drawn in millimetres so the screen and the
// printed PDF are the same page. Used three ways: the design area (editable),
// the pack preview, and the print window (rendered to static HTML).
//
// Inline styles only: the print window receives this as markup, with no app
// stylesheet behind it.

export const ICON_COMPONENTS = {
  FileText, Calculator, Receipt, Landmark, Users, PiggyBank, Wallet, BarChart3, LineChart, TrendingUp,
  Target, Briefcase, Building2, ShieldCheck, ClipboardCheck, CalendarCheck, BookOpen, Coins, Banknote,
  Scale, Handshake, Lightbulb, Home, Fingerprint, Send, MessagesSquare, Compass, FileSpreadsheet,
  UserCheck, Mail, Stamp, Presentation, Rocket, Sparkles,
};

const SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
const SANS = "'Outfit', 'Helvetica Neue', Arial, sans-serif";
const GOLD = '#c9a45c';
const INK = '#1f2937';
const MUTED = '#5b6573';

// Text that can be edited in place in the design area, and is plain text
// everywhere else. Saves on blur; Enter ends a single-line field.
function Editable({ value, onChange, editable, multiline = false, style, placeholder }) {
  if (!editable) return <span style={style}>{value}</span>;
  return (
    <span
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      className="pack-editable"
      onKeyDown={(e) => { if (!multiline && e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      onBlur={(e) => { const t = e.currentTarget.innerText.replace(new RegExp(String.fromCharCode(160), 'g'), ' ').trim(); if (t !== value) onChange(t); }}
      style={{ ...style, outline: 'none', cursor: 'text' }}
    >{value}</span>
  );
}

// The header artwork: a quiet pattern in white over the accent colour.
export function Graphic({ id, height = 92 }) {
  const common = { position: 'absolute', inset: 0, width: '100%', height: '100%' };
  const stroke = { fill: 'none', stroke: '#ffffff', strokeWidth: 0.35 };
  const vb = `0 0 210 ${height}`;
  if (id === 'arcs') {
    return (
      <svg style={common} viewBox={vb} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {[18, 32, 46, 60, 74, 88, 102, 116, 130].map((r, i) => (
          <circle key={r} cx="188" cy={height * 0.28} r={r} {...stroke} opacity={0.2 - i * 0.018} />
        ))}
      </svg>
    );
  }
  if (id === 'waves') {
    return (
      <svg style={common} viewBox={vb} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) => {
          const y = height * 0.35 + i * 6;
          return <path key={i} d={`M0 ${y} C 50 ${y - 14}, 90 ${y + 14}, 140 ${y} S 200 ${y - 12}, 230 ${y}`} {...stroke} opacity={0.2 - i * 0.015} />;
        })}
      </svg>
    );
  }
  if (id === 'grid') {
    return (
      <svg style={common} viewBox={vb} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <linearGradient id="gfade" x1="0" x2="1"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#fff" stopOpacity="1" /></linearGradient>
          <mask id="gmask"><rect width="210" height={height} fill="url(#gfade)" /></mask>
        </defs>
        <g mask="url(#gmask)" opacity="0.16">
          {Array.from({ length: 27 }, (_, i) => <line key={`v${i}`} x1={i * 8} y1="0" x2={i * 8} y2={height} {...stroke} />)}
          {Array.from({ length: Math.ceil(height / 8) + 1 }, (_, i) => <line key={`h${i}`} x1="0" y1={i * 8} x2="210" y2={i * 8} {...stroke} />)}
        </g>
      </svg>
    );
  }
  if (id === 'dots') {
    const dots = [];
    for (let x = 96; x <= 210; x += 5) for (let y = 4; y <= height; y += 5) dots.push(<circle key={`${x}-${y}`} cx={x} cy={y} r="0.55" fill="#fff" opacity={Math.min(0.28, (x - 96) / 400)} />);
    return <svg style={common} viewBox={vb} preserveAspectRatio="xMidYMid slice" aria-hidden="true">{dots}</svg>;
  }
  if (id === 'diagonal') {
    return (
      <svg style={common} viewBox={vb} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {Array.from({ length: 22 }, (_, i) => <line key={i} x1={110 + i * 7} y1="0" x2={60 + i * 7} y2={height} {...stroke} opacity="0.14" />)}
      </svg>
    );
  }
  return null;
}

function Icon({ name, size, color }) {
  const C = ICON_COMPONENTS[name] || FileText;
  return <C size={size} color={color} strokeWidth={1.6} />;
}

function Header({ page, accent, height, children }) {
  return (
    <div style={{ position: 'relative', height: `${height}mm`, background: accent.base, overflow: 'hidden', color: '#fff' }}>
      {page.image ? (
        <>
          <img src={page.image} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(100deg, ${accent.deep}f2 0%, ${accent.base}d9 45%, ${accent.base}66 100%)` }} />
        </>
      ) : (
        <>
          <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(135deg, ${accent.base} 0%, ${accent.deep} 100%)` }} />
          <Graphic id={page.graphic} height={height} />
        </>
      )}
      {children}
    </div>
  );
}

function Footer({ clientName, pageNo, total, dark = false }) {
  const c = dark ? 'rgba(255,255,255,0.6)' : '#8a94a3';
  return (
    <div style={{ position: 'absolute', left: '20mm', right: '20mm', bottom: '10mm', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: SANS, fontSize: '7.5pt', letterSpacing: '0.04em', color: c, borderTop: `0.2mm solid ${dark ? 'rgba(255,255,255,0.2)' : '#e3e7ec'}`, paddingTop: '3mm' }}>
      <span>{clientName ? `Prepared for ${clientName}` : 'Almond Valley Accounting'}</span>
      <span>Almond Valley Accounting{pageNo ? ` · ${pageNo}${total ? ` of ${total}` : ''}` : ''}</span>
    </div>
  );
}

function EditableList({ items, onChange, editable, renderMarker, itemStyle, addLabel }) {
  const set = (i, t) => onChange(items.map((x, j) => (j === i ? t : x)).filter((x, j) => j !== i || t));
  return (
    <div>
      {items.map((t, i) => (
        <div key={`${i}-${t.slice(0, 12)}`} style={{ display: 'flex', gap: '3mm', alignItems: 'flex-start', marginBottom: '3.2mm', position: 'relative' }} className="pack-li">
          {renderMarker(i)}
          <Editable value={t} editable={editable} onChange={(v) => set(i, v)} style={{ flex: 1, ...itemStyle }} />
          {editable && (
            <button type="button" className="pack-li-x" onClick={() => onChange(items.filter((_, j) => j !== i))} title="Remove" style={{ position: 'absolute', right: '-6mm', top: 0, border: 'none', background: 'none', cursor: 'pointer', color: '#b91c1c', padding: 0 }}>
              <X size={12} />
            </button>
          )}
        </div>
      ))}
      {editable && items.length < 12 && (
        <button type="button" onClick={() => onChange([...items, 'New point'])} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px dashed #cbd5e1', background: 'transparent', borderRadius: 6, padding: '2px 8px', fontSize: 11, color: '#64748b', cursor: 'pointer', fontFamily: SANS }}>
          <Plus size={11} /> {addLabel}
        </button>
      )}
    </div>
  );
}

const pageBox = {
  position: 'relative', width: '210mm', height: '297mm', background: '#ffffff', overflow: 'hidden',
  fontFamily: SANS, color: INK, boxSizing: 'border-box', pageBreakAfter: 'always', breakAfter: 'page',
};

// ─── Service page ────────────────────────────────────────────────────
function ServicePage({ page, accent, editable, set, clientName, pageNo, total }) {
  return (
    <div style={pageBox}>
      <Header page={page} accent={accent} height={104}>
        <div style={{ position: 'absolute', left: '20mm', top: '14mm', fontSize: '7.5pt', letterSpacing: '0.24em', fontWeight: 600, color: 'rgba(255,255,255,0.72)' }}>ALMOND VALLEY ACCOUNTING</div>
        <div style={{ position: 'absolute', left: '20mm', right: '20mm', bottom: '20mm' }}>
          <div style={{ width: '14mm', height: '0.6mm', background: GOLD, marginBottom: '5mm' }} />
          <Editable value={page.title} editable={editable} onChange={(v) => set('title', v)}
            style={{ display: 'block', fontFamily: SERIF, fontSize: '31pt', lineHeight: 1.12, fontWeight: 500, color: '#fff', maxWidth: '150mm' }} />
          <Editable value={page.tagline} editable={editable} onChange={(v) => set('tagline', v)}
            style={{ display: 'block', marginTop: '3.5mm', fontSize: '11.5pt', lineHeight: 1.45, color: 'rgba(255,255,255,0.86)', maxWidth: '140mm', fontWeight: 300 }} />
        </div>
      </Header>
      <div style={{ position: 'absolute', right: '20mm', top: '92mm', width: '24mm', height: '24mm', borderRadius: '50%', background: '#fff', boxShadow: '0 1.5mm 5mm rgba(16,40,58,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={page.icon} size={36} color={accent.base} />
      </div>

      <div style={{ padding: '26mm 20mm 0' }}>
        <div style={{ fontSize: '7.5pt', letterSpacing: '0.2em', fontWeight: 600, color: GOLD, marginBottom: '3mm' }}>WHAT IT IS</div>
        <Editable value={page.intro} editable={editable} multiline onChange={(v) => set('intro', v)}
          style={{ display: 'block', fontSize: '13.5pt', lineHeight: 1.6, color: INK, maxWidth: '155mm', fontWeight: 400 }} />

        <div style={{ display: 'flex', gap: '10mm', marginTop: '18mm' }}>
          <div style={{ flex: 1.15 }}>
            <div style={{ fontFamily: SERIF, fontSize: '17pt', color: accent.base, marginBottom: '6mm' }}>What we do</div>
            <EditableList items={page.weDo || []} editable={editable} onChange={(v) => set('weDo', v)} addLabel="Add a point"
              itemStyle={{ fontSize: '11.5pt', lineHeight: 1.5, color: INK }}
              renderMarker={() => (
                <span style={{ flex: '0 0 auto', width: '5mm', height: '5mm', borderRadius: '50%', background: accent.soft, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginTop: '0.4mm' }}>
                  <Check size={11} color={accent.base} strokeWidth={2.4} />
                </span>
              )} />
          </div>
          <div style={{ flex: 1, background: accent.soft, borderRadius: '2.5mm', padding: '7mm 7mm 4mm', alignSelf: 'flex-start' }}>
            <div style={{ fontFamily: SERIF, fontSize: '17pt', color: accent.base, marginBottom: '6mm' }}>What we need from you</div>
            <EditableList items={page.youProvide || []} editable={editable} onChange={(v) => set('youProvide', v)} addLabel="Add a point"
              itemStyle={{ fontSize: '11.5pt', lineHeight: 1.5, color: INK }}
              renderMarker={() => <span style={{ flex: '0 0 auto', width: '1.6mm', height: '1.6mm', background: GOLD, transform: 'rotate(45deg)', marginTop: '2.2mm' }} />} />
          </div>
        </div>
      </div>
      <Footer clientName={clientName} pageNo={pageNo} total={total} />
    </div>
  );
}

// ─── Cover ───────────────────────────────────────────────────────────
function CoverPage({ page, accent, editable, set, clientName, services, logoUrl, dateText }) {
  return (
    <div style={pageBox}>
      <Header page={page} accent={accent} height={190}>
        <div style={{ position: 'absolute', left: '20mm', top: '18mm', display: 'flex', alignItems: 'center', gap: '4mm' }}>
          {logoUrl && <img src={logoUrl} alt="" style={{ width: '15mm', height: '15mm', borderRadius: '2mm' }} />}
          <span style={{ fontSize: '8pt', letterSpacing: '0.24em', fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>ALMOND VALLEY ACCOUNTING</span>
        </div>
        <div style={{ position: 'absolute', left: '20mm', right: '20mm', bottom: '26mm' }}>
          <div style={{ width: '16mm', height: '0.7mm', background: GOLD, marginBottom: '7mm' }} />
          <Editable value={page.title} editable={editable} onChange={(v) => set('title', v)}
            style={{ display: 'block', fontSize: '10pt', letterSpacing: '0.26em', textTransform: 'uppercase', color: GOLD, fontWeight: 600 }} />
          <div style={{ fontFamily: SERIF, fontSize: '38pt', lineHeight: 1.08, fontWeight: 500, color: '#fff', marginTop: '4mm', maxWidth: '165mm' }}>
            {clientName || 'Your business'}
          </div>
          <Editable value={page.tagline} editable={editable} onChange={(v) => set('tagline', v)}
            style={{ display: 'block', marginTop: '5mm', fontSize: '12pt', color: 'rgba(255,255,255,0.85)', fontWeight: 300 }} />
          <div style={{ marginTop: '8mm', fontSize: '9pt', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.65)' }}>{dateText}</div>
        </div>
      </Header>
      <div style={{ padding: '16mm 20mm 0', display: 'flex', gap: '12mm' }}>
        <div style={{ flex: 1.1 }}>
          <Editable value={page.intro} editable={editable} multiline onChange={(v) => set('intro', v)}
            style={{ display: 'block', fontSize: '13pt', lineHeight: 1.6, color: INK }} />
        </div>
        <div style={{ flex: 1, borderLeft: `0.5mm solid ${GOLD}`, paddingLeft: '7mm' }}>
          <div style={{ fontSize: '7.5pt', letterSpacing: '0.2em', fontWeight: 600, color: MUTED, marginBottom: '4mm' }}>IN THIS PROPOSAL</div>
          {(services || []).map((s) => (
            <div key={s} style={{ fontFamily: SERIF, fontSize: '11.5pt', color: accent.base, marginBottom: '2.6mm' }}>{s}</div>
          ))}
          {(!services || services.length === 0) && <div style={{ fontSize: '10pt', color: MUTED }}>The services you choose appear here.</div>}
        </div>
      </div>
      <Footer clientName={null} />
    </div>
  );
}

// ─── Next steps ──────────────────────────────────────────────────────
function NextStepsPage({ page, accent, editable, set, clientName, pageNo, total }) {
  return (
    <div style={pageBox}>
      <Header page={page} accent={accent} height={74}>
        <div style={{ position: 'absolute', left: '20mm', top: '14mm', fontSize: '7.5pt', letterSpacing: '0.24em', fontWeight: 600, color: 'rgba(255,255,255,0.72)' }}>ALMOND VALLEY ACCOUNTING</div>
        <div style={{ position: 'absolute', left: '20mm', right: '20mm', bottom: '16mm' }}>
          <div style={{ width: '14mm', height: '0.6mm', background: GOLD, marginBottom: '5mm' }} />
          <Editable value={page.title} editable={editable} onChange={(v) => set('title', v)}
            style={{ display: 'block', fontFamily: SERIF, fontSize: '28pt', fontWeight: 500, color: '#fff' }} />
          <Editable value={page.tagline} editable={editable} onChange={(v) => set('tagline', v)}
            style={{ display: 'block', marginTop: '3mm', fontSize: '11.5pt', color: 'rgba(255,255,255,0.86)', fontWeight: 300 }} />
        </div>
      </Header>
      <div style={{ padding: '18mm 20mm 0' }}>
        <Editable value={page.intro} editable={editable} multiline onChange={(v) => set('intro', v)}
          style={{ display: 'block', fontSize: '12pt', lineHeight: 1.6, color: INK, maxWidth: '150mm', marginBottom: '12mm' }} />
        <EditableList items={page.weDo || []} editable={editable} onChange={(v) => set('weDo', v)} addLabel="Add a step"
          itemStyle={{ fontSize: '12pt', lineHeight: 1.5, color: INK, paddingTop: '1.5mm' }}
          renderMarker={(i) => (
            <span style={{ flex: '0 0 auto', width: '11mm', fontFamily: SERIF, fontSize: '22pt', lineHeight: 1, color: GOLD }}>{String(i + 1).padStart(2, '0')}</span>
          )} />
        <div style={{ marginTop: '16mm', background: accent.soft, borderRadius: '2.5mm', padding: '8mm 9mm', display: 'flex', gap: '6mm', alignItems: 'center' }}>
          <Icon name={page.icon} size={30} color={accent.base} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: SERIF, fontSize: '13pt', color: accent.base, marginBottom: '2mm' }}>Any questions?</div>
            <EditableList items={page.youProvide || []} editable={editable} onChange={(v) => set('youProvide', v)} addLabel="Add a line"
              itemStyle={{ fontSize: '10pt', lineHeight: 1.45, color: INK }} renderMarker={() => null} />
          </div>
        </div>
      </div>
      <Footer clientName={clientName} pageNo={pageNo} total={total} />
    </div>
  );
}

export default function PackPage({ page, editable = false, onChange, clientName = '', services = [], pageNo, total, logoUrl = '/ava-logo.jpg', dateText = '' }) {
  const accent = ACCENTS[page.accent] || ACCENTS.ocean;
  const set = (field, value) => onChange && onChange({ ...page, [field]: value });
  const props = { page, accent, editable, set, clientName, pageNo, total };
  if (page.kind === 'cover') return <CoverPage {...props} services={services} logoUrl={logoUrl} dateText={dateText} />;
  if (page.kind === 'next') return <NextStepsPage {...props} />;
  return <ServicePage {...props} />;
}
