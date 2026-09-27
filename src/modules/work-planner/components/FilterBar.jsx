import React from 'react';
import TypeAhead from './TypeAhead';
import Avatar from './Avatar';
import AlphabetFilter from '../../../components/AlphabetFilter';
import { SERVICES, CALENDAR_VIEWS } from '../lib/constants';
import { teamColour } from '../lib/helpers';
import { BTN } from '../../../lib/buttonStyles';

const sepStyle = { width: 1, height: 20, background: '#e5e7eb', margin: '0 4px' };
const labelStyle = {
  fontWeight: 600, color: '#94a3b8', fontSize: 12, fontFamily: "'Outfit', sans-serif",
};
const btnStyle = { ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', whiteSpace: 'nowrap' };
const btnActiveStyle = { ...btnStyle, background: '#dbeafe', borderColor: '#0e7fe0', color: '#0e7fe0' };
const selectStyle = {
  padding: '3px 8px', fontSize: 13, fontFamily: "'Outfit', sans-serif",
  border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: '#1e293b', outline: 'none',
};

export default function FilterBar({
  staffList,
  entityList,
  teamFilter, setTeamFilter,
  clientFilter, setClientFilter,
  clientLetter, setClientLetter,
  serviceFilter, setServiceFilter,
  // Calendar-specific
  view,
  calendarView, setCalendarView,
  calTitle, onCalNav, onCalToday,
  // Kanban + MyTasks
  dueFilter, setDueFilter,
  // MyTasks-specific
  sourceFilter, setSourceFilter,
  // Quick + MyTasks
  compact, setCompact,
  searchTerm, setSearchTerm,
  // Scheduled-specific
  sort, setSort,
  // Colour mode
  colourMode, setColourMode,
  staffColours,
  // Buttons pinned to the right of the row (the new-task actions).
  rightSlot = null,
}) {
  // Build staffMap locally for Avatar
  const staffMap = {};
  staffList.forEach((s) => { staffMap[s.id] = s; });

  const entityItems = entityList.map((e) => ({ id: e.id, label: e.name }));
  const serviceItems = SERVICES.map((s) => ({ id: s, label: s }));

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '6px 16px', background: '#fff',
        borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap',
        fontSize: 13, fontFamily: "'Outfit', sans-serif",
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

      {/* Only the controls a view reads (audit 2026-09-27): Client on Quick
          Tasks, Planner, Stage board, Completed; Service on Quick Tasks,
          Blocks, Planner, Completed. No view reads Status, so it is gone. */}
      {['quick', 'calendar', 'kanban', 'completed'].includes(view) && (
        <>
          <div style={sepStyle} />
          <span style={labelStyle}>Client</span>
          <TypeAhead items={entityItems} value={clientFilter} onChange={setClientFilter} placeholder="Client..." />
        </>
      )}
      {['quick', 'sched', 'calendar', 'completed'].includes(view) && (
        <>
          <div style={sepStyle} />
          <span style={labelStyle}>Service</span>
          <TypeAhead items={serviceItems} value={serviceFilter} onChange={setServiceFilter} placeholder="Service..." />
        </>
      )}

      {/* Calendar controls */}
      {view === 'calendar' && (
        <>
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
          <button style={btnStyle} onClick={() => onCalNav(-1)}>&#8592;</button>
          <span style={{ fontSize: 14, fontWeight: 500, minWidth: 120, textAlign: 'center' }}>
            {calTitle}
          </span>
          <button style={btnStyle} onClick={() => onCalNav(1)}>&#8594;</button>
          <button style={btnStyle} onClick={onCalToday}>Today</button>
        </>
      )}

      {/* Compact toggle — quick tasks */}
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

      {/* A–Z quick jumper for the client axis. Disabled letters are
          those with no entries in entityList. Null = All; a chosen
          letter filters lists by entity first-letter. Only Quick Tasks
          applies clientLetter, so it only shows there. */}
      {rightSlot && (
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>{rightSlot}</div>
      )}
      {view === 'quick' && (
        <div style={{ flexBasis: '100%', marginTop: 4 }}>
          <AlphabetFilter
            items={entityList}
            selected={clientLetter || null}
            onChange={setClientLetter}
          />
        </div>
      )}
    </div>
  );
}
