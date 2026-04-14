import React from 'react';
import TypeAhead from './TypeAhead';
import Avatar from './Avatar';
import { Palette } from 'lucide-react';
import { SERVICES, STATUSES, CALENDAR_VIEWS, KANBAN_DUE_FILTERS } from '../lib/constants';
import { teamColour } from '../lib/helpers';

const sepStyle = { width: 1, height: 20, background: '#e5e7eb', margin: '0 4px' };
const labelStyle = {
  fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase',
  letterSpacing: '0.4px', fontSize: 11, fontFamily: "'Outfit', sans-serif",
};
const btnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', fontSize: 12, fontWeight: 500,
  fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb',
  borderRadius: 8, background: '#fff', color: '#1e293b',
  cursor: 'pointer', whiteSpace: 'nowrap',
};
const btnActiveStyle = { ...btnStyle, background: '#dbeafe', borderColor: '#0e7fe0', color: '#0e7fe0' };
const selectStyle = {
  padding: '3px 8px', fontSize: 12, fontFamily: "'Outfit', sans-serif",
  border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: '#1e293b', outline: 'none',
};

export default function FilterBar({
  staffList,
  entityList,
  teamFilter, setTeamFilter,
  clientFilter, setClientFilter,
  serviceFilter, setServiceFilter,
  statusFilter, setStatusFilter,
  // Calendar-specific
  view,
  calendarView, setCalendarView,
  calTitle, onCalNav, onCalToday,
  // Kanban-specific
  dueFilter, setDueFilter,
  // Quick-specific
  compact, setCompact,
  // Scheduled-specific
  sort, setSort,
  // Colour mode
  colourMode, setColourMode,
  onOpenColourSettings,
  staffColours,
}) {
  // Build staffMap locally for Avatar
  const staffMap = {};
  staffList.forEach((s) => { staffMap[s.id] = s; });

  const entityItems = entityList.map((e) => ({ id: e.id, label: e.name }));
  const serviceItems = SERVICES.map((s) => ({ id: s, label: s }));
  const statusItems = STATUSES.map((s) => ({ id: s.id, label: s.label }));

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '6px 16px', background: '#fff',
        borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap',
        fontSize: 12, fontFamily: "'Outfit', sans-serif",
      }}
    >
      {/* Staff avatar buttons */}
      <span style={labelStyle}>Team</span>
      {staffList.map((s) => (
        <div
          key={s.id}
          onClick={() => setTeamFilter(teamFilter === s.id ? '' : s.id)}
          title={s.name}
          style={{
            cursor: 'pointer',
            borderRadius: '50%',
            border: teamFilter === s.id ? '2px solid #0e7fe0' : '2px solid transparent',
            padding: 1,
            transition: 'all 0.12s',
            opacity: teamFilter && teamFilter !== s.id ? 0.35 : 1,
          }}
        >
          <Avatar id={s.id} staffMap={staffMap} size={22} customColour={staffColours?.[s.id]} />
        </div>
      ))}

      <div style={sepStyle} />
      <span style={labelStyle}>Client</span>
      <TypeAhead items={entityItems} value={clientFilter} onChange={setClientFilter} placeholder="Client..." />

      <div style={sepStyle} />
      <span style={labelStyle}>Service</span>
      <TypeAhead items={serviceItems} value={serviceFilter} onChange={setServiceFilter} placeholder="Service..." />

      <div style={sepStyle} />
      <span style={labelStyle}>Status</span>
      <TypeAhead items={statusItems} value={statusFilter} onChange={setStatusFilter} placeholder="Status..." />

      {/* Calendar controls */}
      {view === 'calendar' && (
        <>
          <div style={sepStyle} />
          <button style={btnStyle} onClick={() => onCalNav(-1)}>&#8592;</button>
          <span style={{ fontSize: 13, fontWeight: 500, minWidth: 120, textAlign: 'center' }}>
            {calTitle}
          </span>
          <button style={btnStyle} onClick={() => onCalNav(1)}>&#8594;</button>
          <button style={btnStyle} onClick={onCalToday}>Today</button>
          <div style={sepStyle} />
          {CALENDAR_VIEWS.map((v) => (
            <button
              key={v.id}
              style={calendarView === v.id ? btnActiveStyle : btnStyle}
              onClick={() => setCalendarView(v.id)}
            >
              {v.label}
            </button>
          ))}
          <div style={sepStyle} />
          <span style={labelStyle}>Colour</span>
          <button
            style={colourMode === 'staff' ? btnActiveStyle : btnStyle}
            onClick={() => setColourMode('staff')}
          >
            By Staff
          </button>
          <button
            style={colourMode === 'status' ? btnActiveStyle : btnStyle}
            onClick={() => setColourMode('status')}
          >
            By Status
          </button>
          <button
            style={btnStyle}
            onClick={onOpenColourSettings}
            title="Edit colours"
          >
            <Palette size={13} />
          </button>
        </>
      )}

      {/* Kanban due filter */}
      {view === 'kanban' && (
        <>
          <div style={sepStyle} />
          <span style={labelStyle}>Due</span>
          <select style={selectStyle} value={dueFilter} onChange={(e) => setDueFilter(e.target.value)}>
            {KANBAN_DUE_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        </>
      )}

      {/* Quick tasks compact toggle */}
      {view === 'quick' && (
        <>
          <div style={sepStyle} />
          <span
            style={compact ? btnActiveStyle : btnStyle}
            onClick={() => setCompact(!compact)}
          >
            Compact
          </span>
        </>
      )}

      {/* Scheduled sort */}
      {view === 'sched' && (
        <>
          <div style={sepStyle} />
          <span style={labelStyle}>Sort</span>
          <select style={selectStyle} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="title">Title</option>
            <option value="client">Client</option>
            <option value="service">Service</option>
            <option value="owner">Owner</option>
            <option value="next">Next Due</option>
          </select>
        </>
      )}
    </div>
  );
}
