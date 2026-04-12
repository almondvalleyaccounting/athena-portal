import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';
import { downloadCSV } from '../lib/exportUtils';

const STATUS_LABELS = { draft: 'Draft', pending_approval: 'Awaiting Approval', approved: 'Approved', sent: 'Sent to Client', accepted: 'Accepted', declined: 'Rejected', expired: 'Expired' };
const FILTER_STATUS_OPTIONS = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired'];

// Status card definitions — pipeline is the aggregate default
const PIPELINE_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'accepted'];
const STATUS_CARDS = [
  { key: 'draft', label: 'Draft', statuses: ['draft'] },
  { key: 'pending_approval', label: 'Awaiting Approval', statuses: ['pending_approval'] },
  { key: 'approved', label: 'Approved', statuses: ['approved'] },
  { key: 'sent', label: 'Sent to Client', statuses: ['sent'] },
  { key: 'accepted', label: 'Accepted', statuses: ['accepted'] },
  { key: 'pipeline', label: 'Pipeline', statuses: PIPELINE_STATUSES },
  { key: 'declined', label: 'Rejected', statuses: ['declined'] },
  { key: 'committed', label: 'Committed', statuses: ['committed'] },
];

export default function QuotesPage() {
  const navigate = useNavigate();
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCard, setActiveCard] = useState('pipeline'); // default card
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState('created_at');
  const [sortAsc, setSortAsc] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [acting, setActing] = useState(false);
  const [groups, setGroups] = useState([]);
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [netGross, setNetGross] = useState('net');

  // ── Filter chips (client/group only — status is handled by cards) ──
  const [chipFilters, setChipFilters] = useState([]);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showClientInput, setShowClientInput] = useState(false);
  const [clientFilterInput, setClientFilterInput] = useState('');
  const [showGroupSubmenu, setShowGroupSubmenu] = useState(false);

  const addChip = (type, value, extra) => {
    setChipFilters(prev => {
      if (type === 'client') {
        if (prev.some(c => c.type === 'client' && c.value === value)) return prev;
        return [...prev, { type, value }];
      }
      if (type === 'group') return [...prev.filter(c => c.type !== 'group'), { type, value, ...extra }];
      return [...prev, { type, value }];
    });
    setShowFilterMenu(false);
    setShowClientInput(false);
    setShowGroupSubmenu(false);
    setClientFilterInput('');
  };

  const removeChip = (idx) => {
    setChipFilters(prev => prev.filter((_, i) => i !== idx));
  };

  const chipClientFilters = chipFilters.filter(c => c.type === 'client').map(c => c.value);
  const chipGroupFilter = chipFilters.find(c => c.type === 'group')?.groupId || null;

  useEffect(() => {
    supabase.from('billing_groups').select('*').order('name')
      .then(({ data }) => setGroups(data || []));
  }, []);

  const loadQuotes = async () => {
    try {
      const { data } = await supabase
        .from('quotes')
        .select('*')
        .order('created_at', { ascending: false });
      setQuotes(data || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { loadQuotes(); }, []);

  const toggleSelect = (id, e) => {
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(q => q.id)));
  };

  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); };

  const selectedQuotes = quotes.filter(q => selected.has(q.id));

  // ── Batch actions ──
  const batchUpdateStatus = async (newStatus) => {
    setActing(true);
    for (const q of selectedQuotes) {
      await supabase.from('quotes').update({ status: newStatus }).eq('id', q.id);
    }
    await loadQuotes();
    setSelected(new Set());
    setActing(false);
  };

  const batchDelete = async () => {
    setActing(true);
    for (const q of selectedQuotes) {
      await supabase.from('quotes').update({ status: 'deleted' }).eq('id', q.id);
    }
    await loadQuotes();
    setSelected(new Set());
    setActing(false);
  };

  const handleAddToGroup = async (groupId) => {
    setActing(true);
    setShowGroupPicker(false);
    try {
      for (const q of selectedQuotes) {
        await supabase.from('quotes').update({ group_id: groupId }).eq('id', q.id);
        if (q.entity_id) {
          await supabase.from('billing_group_members')
            .upsert({ entity_id: q.entity_id, group_id: groupId });
        }
      }
      navigate('/manage/quotes/group/' + groupId);
    } catch (e) { console.error(e); }
    setActing(false);
  };

  const handleCreateGroup = async () => {
    if (selected.size < 2) return;
    setActing(true);
    try {
      const groupName = selectedQuotes.map(q => q.relationship_group || 'Entity').join(' + ');
      const { data: group } = await supabase
        .from('billing_groups')
        .insert({ name: groupName })
        .select().single();

      for (const q of selectedQuotes) {
        await supabase.from('quotes').update({ group_id: group.id }).eq('id', q.id);
        if (q.entity_id) {
          await supabase.from('billing_group_members')
            .upsert({ entity_id: q.entity_id, group_id: group.id });
        }
      }
      navigate('/manage/quotes/group/' + group.id);
    } catch (e) { console.error(e); }
    setActing(false);
  };

  // Determine valid batch actions based on selected quotes
  const selectedStatuses = new Set(selectedQuotes.map(q => q.status));
  const allDraft = selectedStatuses.size === 1 && selectedStatuses.has('draft');
  const allPendingApproval = selectedStatuses.size === 1 && selectedStatuses.has('pending_approval');
  const allApproved = selectedStatuses.size === 1 && selectedStatuses.has('approved');
  const allSent = selectedStatuses.size === 1 && selectedStatuses.has('sent');
  const canReject = selectedQuotes.length > 0 && selectedQuotes.every(q => q.status !== 'accepted' && q.status !== 'committed');
  const canDelete = selectedQuotes.length > 0 && selectedQuotes.every(q => q.status === 'draft' || q.status === 'pending_approval');
  const canGroup = selected.size >= 2;
  const canAddToGroup = selected.size > 0;

  // ── Status card aggregates (always computed from ALL quotes, unfiltered) ──
  const cardData = useMemo(() => {
    const visible = quotes.filter(q => q.status !== 'deleted');
    const result = {};
    STATUS_CARDS.forEach(card => {
      const matching = visible.filter(q => card.statuses.includes(q.status));
      result[card.key] = {
        count: matching.length,
        value: matching.reduce((s, q) => s + (parseFloat(q.annual_total) || 0), 0),
      };
    });
    return result;
  }, [quotes]);

  // ── Filtering & sorting ──
  const filtered = useMemo(() => {
    let list = quotes.filter(q => q.status !== 'deleted');

    // Apply active card filter
    const card = STATUS_CARDS.find(c => c.key === activeCard);
    if (card) {
      list = list.filter(q => card.statuses.includes(q.status));
    }

    // Apply chip filters (client/group only)
    chipClientFilters.forEach(cf => {
      const lower = cf.toLowerCase();
      list = list.filter(q => q.relationship_group?.toLowerCase().includes(lower));
    });
    if (chipGroupFilter) list = list.filter(q => q.group_id === chipGroupFilter);

    if (search) {
      const s = search.toLowerCase();
      list = list.filter(q =>
        q.quote_ref?.toLowerCase().includes(s) ||
        q.relationship_group?.toLowerCase().includes(s)
      );
    }
    list = [...list].sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (sortCol === 'created_at') { va = new Date(va); vb = new Date(vb); }
      if (sortCol === 'monthly_gross' || sortCol === 'annual_total' || sortCol === 'monthly_net') { va = va || 0; vb = vb || 0; }
      if (sortCol === 'quote_ref' || sortCol === 'relationship_group' || sortCol === 'status') { va = (va || '').toLowerCase(); vb = (vb || '').toLowerCase(); }
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });
    return list;
  }, [quotes, activeCard, search, sortCol, sortAsc, chipClientFilters, chipGroupFilter]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  const SortHeader = ({ col, children, className = '' }) => (
    <button onClick={() => toggleSort(col)} className={`text-left text-xs text-gray-400 hover:text-gray-600 flex items-center gap-0.5 ${className}`}>
      {children}
      {sortCol === col && <span className="text-ocean-500">{sortAsc ? '\u25B2' : '\u25BC'}</span>}
    </button>
  );

  const groupMap = useMemo(() => {
    const m = {};
    groups.forEach(g => { m[g.id] = g.name; });
    return m;
  }, [groups]);

  // ── Export helpers ──
  const getExportRows = () => filtered.map(q => [
    q.quote_ref || '',
    q.relationship_group || '',
    (q.group_id && groupMap[q.group_id]) || '',
    STATUS_LABELS[q.status] || q.status || '',
    q.annual_total ?? '',
    q.monthly_net ?? '',
    q.vat ?? '',
    q.monthly_gross ?? '',
    q.created_at ? new Date(q.created_at).toLocaleDateString('en-GB') : '',
    q.valid_until ? new Date(q.valid_until).toLocaleDateString('en-GB') : '',
  ]);
  const exportHeaders = ['Quote Ref', 'Client', 'Group', 'Status', 'Annual Net', 'Monthly Net', 'VAT', 'Monthly Gross', 'Created Date', 'Valid Until'];

  const handleExportCSV = () => {
    downloadCSV('quotes_export.csv', exportHeaders, getExportRows());
  };

  const handleExportPDF = async () => {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 10;
    const usable = pageWidth - margin * 2;
    const colWidth = usable / exportHeaders.length;
    const rowHeight = 7;
    let y = 15;

    doc.setFontSize(14);
    doc.text('Quotes Export', margin, y);
    y += 10;

    doc.setFontSize(8);
    doc.setFont(undefined, 'bold');
    exportHeaders.forEach((h, i) => { doc.text(h, margin + i * colWidth, y); });
    doc.setFont(undefined, 'normal');
    y += 2;
    doc.setDrawColor(180);
    doc.line(margin, y, pageWidth - margin, y);
    y += rowHeight - 2;

    doc.setFontSize(7);
    getExportRows().forEach(row => {
      if (y > doc.internal.pageSize.getHeight() - 15) { doc.addPage(); y = 15; }
      row.forEach((cell, i) => { doc.text(String(cell ?? ''), margin + i * colWidth, y); });
      y += rowHeight;
    });

    doc.save('quotes_export.pdf');
  };

  const gridCols = selectMode
    ? '24px 2fr 1fr 1fr 1fr 1fr 1fr 1fr'
    : '2fr 1fr 1fr 1fr 1fr 1fr 1fr';

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold text-ocean-700">Quotes</h2>
        <div className="flex gap-2 items-center">
          {/* Net / Gross toggle */}
          <div className="inline-flex rounded-md border border-gray-200 overflow-hidden text-xs">
            <button
              onClick={() => setNetGross('net')}
              className={`px-3 py-1.5 transition-all ${netGross === 'net' ? 'bg-ocean-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
            >
              Net
            </button>
            <button
              onClick={() => setNetGross('gross')}
              className={`px-3 py-1.5 transition-all ${netGross === 'gross' ? 'bg-ocean-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
            >
              Gross
            </button>
          </div>
          <Btn onClick={handleExportCSV} variant="ghost" className="text-xs">Export Excel</Btn>
          <Btn onClick={handleExportPDF} variant="ghost" className="text-xs">Export PDF</Btn>
          {!selectMode ? (
            <>
              <Btn onClick={() => setSelectMode(true)} variant="ghost">Select</Btn>
              <Btn onClick={() => navigate('/manage/quotes/new')}>New Quote</Btn>
            </>
          ) : (
            <Btn onClick={exitSelectMode} variant="ghost">Cancel</Btn>
          )}
        </div>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        {STATUS_CARDS.map(card => {
          const d = cardData[card.key] || { count: 0, value: 0 };
          const isActive = activeCard === card.key;
          const isPipeline = card.key === 'pipeline';
          return (
            <button
              key={card.key}
              onClick={() => setActiveCard(card.key)}
              className={`text-left rounded-lg border-2 px-3 py-2.5 transition-all ${
                isActive
                  ? 'border-ocean-500 bg-ocean-50'
                  : 'border-gray-200 bg-white hover:border-ocean-200'
              } ${isPipeline ? 'col-span-2' : ''}`}
            >
              <div className="text-[11px] text-gray-500 font-medium mb-1">{card.label}</div>
              <div className="flex items-baseline justify-between gap-2">
                <span className={`text-lg font-bold ${isActive ? 'text-ocean-700' : 'text-gray-700'}`}>{d.count}</span>
                <span className={`text-xs font-mono ${isActive ? 'text-ocean-600' : 'text-gray-400'}`}>{fmt(d.value)}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Batch action bar */}
      {selectMode && selected.size > 0 && (
        <div className="flex items-center gap-2 mb-3 bg-ocean-50 rounded-lg p-2 border border-ocean-200 flex-wrap">
          <span className="text-xs text-ocean-700 font-medium">{selected.size} selected</span>
          <span className="text-ocean-300">|</span>
          {allDraft && <Btn onClick={() => batchUpdateStatus('pending_approval')} disabled={acting} variant="secondary" className="text-xs py-1 px-2">Submit for Approval</Btn>}
          {allPendingApproval && <Btn onClick={() => batchUpdateStatus('approved')} disabled={acting} variant="primary" className="text-xs py-1 px-2">Approve</Btn>}
          {allApproved && <Btn onClick={() => batchUpdateStatus('sent')} disabled={acting} variant="secondary" className="text-xs py-1 px-2">Mark as Sent</Btn>}
          {allSent && <Btn onClick={() => batchUpdateStatus('accepted')} disabled={acting} variant="secondary" className="text-xs py-1 px-2">Mark Accepted</Btn>}
          {canReject && <Btn onClick={() => batchUpdateStatus('declined')} disabled={acting} variant="ghost" className="text-xs py-1 px-2 text-red-600 hover:bg-red-50">Reject</Btn>}
          {canDelete && <Btn onClick={batchDelete} disabled={acting} variant="ghost" className="text-xs py-1 px-2 text-red-600 hover:bg-red-50">Delete</Btn>}
          {canGroup && <Btn onClick={handleCreateGroup} disabled={acting} variant="secondary" className="text-xs py-1 px-2">Create Group</Btn>}
          {canAddToGroup && (
            <div className="relative">
              <Btn onClick={() => setShowGroupPicker(!showGroupPicker)} disabled={acting || groups.length === 0} variant="secondary" className="text-xs py-1 px-2">
                Add to Group
              </Btn>
              {showGroupPicker && groups.length > 0 && (
                <div className="absolute z-20 top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg min-w-[180px]">
                  {groups.map(g => (
                    <button key={g.id} onClick={() => handleAddToGroup(g.id)} className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 border-b border-gray-50 last:border-0">
                      {g.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Search */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search by quote ref or client name..."
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-3"
      />

      {/* Filter chips bar (client/group only) */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        {chipFilters.map((chip, i) => (
          <span key={i} className="inline-flex items-center gap-1 text-xs bg-ocean-50 text-ocean-700 border border-ocean-200 rounded-full px-2.5 py-1">
            {chip.type === 'group' ? `Group: ${chip.value}` : `Client: ${chip.value}`}
            <button onClick={() => removeChip(i)} className="text-ocean-400 hover:text-ocean-700 ml-0.5">&times;</button>
          </span>
        ))}
        <div className="relative">
          <button
            onClick={() => { setShowFilterMenu(!showFilterMenu); setShowClientInput(false); setShowGroupSubmenu(false); }}
            className="text-xs px-2.5 py-1 rounded-full border border-dashed border-gray-300 text-gray-500 hover:border-ocean-400 hover:text-ocean-600 transition-all"
          >
            + Filter
          </button>
          {showFilterMenu && (
            <div className="absolute z-20 top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg min-w-[160px]">
              <button
                onClick={() => { setShowClientInput(!showClientInput); setShowGroupSubmenu(false); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 border-b border-gray-50 flex justify-between items-center"
              >
                Client <span className="text-gray-400">&rsaquo;</span>
              </button>
              {showClientInput && (
                <div className="px-3 pb-2">
                  <input
                    value={clientFilterInput}
                    onChange={e => setClientFilterInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && clientFilterInput.trim()) addChip('client', clientFilterInput.trim()); }}
                    placeholder="Type client name..."
                    className="w-full text-xs border border-gray-200 rounded px-2 py-1"
                    autoFocus
                  />
                  <button
                    onClick={() => { if (clientFilterInput.trim()) addChip('client', clientFilterInput.trim()); }}
                    className="text-xs text-ocean-600 hover:text-ocean-700 mt-1"
                  >
                    Apply
                  </button>
                </div>
              )}
              <button
                onClick={() => { setShowGroupSubmenu(!showGroupSubmenu); setShowClientInput(false); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 flex justify-between items-center"
              >
                Group <span className="text-gray-400">&rsaquo;</span>
              </button>
              {showGroupSubmenu && (
                <div className="border-t border-gray-100 max-h-48 overflow-y-auto">
                  {groups.length === 0 ? (
                    <span className="block px-5 py-1.5 text-xs text-gray-400">No groups</span>
                  ) : groups.map(g => (
                    <button key={g.id} onClick={() => addChip('group', g.name, { groupId: g.id })} className="w-full text-left px-5 py-1.5 text-xs hover:bg-ocean-50 text-gray-600">
                      {g.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-400 mb-3">
            {quotes.length === 0 ? 'No quotes yet. Create your first quote to get started.' : 'No quotes match your filters.'}
          </p>
          {quotes.length === 0 && <Btn onClick={() => navigate('/manage/quotes/new')}>New Quote</Btn>}
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {/* Column headers */}
          <div className="grid gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50" style={{ gridTemplateColumns: gridCols }}>
            {selectMode && (
              <input
                type="checkbox"
                checked={selected.size === filtered.length && filtered.length > 0}
                onChange={selectAll}
                className="w-3 h-3 accent-ocean-600"
              />
            )}
            <SortHeader col="quote_ref">Quote Ref</SortHeader>
            <SortHeader col="relationship_group">Client</SortHeader>
            <span className="text-xs text-gray-400">Group</span>
            <SortHeader col="status">Status</SortHeader>
            <SortHeader col={netGross === 'net' ? 'monthly_net' : 'monthly_gross'} className="justify-end">{netGross === 'net' ? 'Monthly (Net)' : 'Monthly (Gross)'}</SortHeader>
            <SortHeader col="annual_total" className="justify-end">Annual (Net)</SortHeader>
            <SortHeader col="created_at" className="justify-end">Created</SortHeader>
          </div>
          {/* Rows */}
          {filtered.map(q => (
            <div
              key={q.id}
              onClick={() => selectMode ? toggleSelect(q.id, { stopPropagation: () => {} }) : navigate('/manage/quotes/' + q.id)}
              className={`grid gap-2 px-4 py-2.5 border-b border-gray-50 last:border-0 cursor-pointer items-center text-xs transition-all ${
                selected.has(q.id) ? 'bg-ocean-50' : 'hover:bg-gray-50'
              }`}
              style={{ gridTemplateColumns: gridCols }}
            >
              {selectMode && (
                <input
                  type="checkbox"
                  checked={selected.has(q.id)}
                  onChange={(e) => toggleSelect(q.id, e)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-3 h-3 accent-ocean-600"
                />
              )}
              <span className="font-medium text-gray-700 truncate">
                {q.quote_ref}
                {q.group_id && <span className="ml-1 text-[9px] bg-ocean-50 text-ocean-600 px-1 rounded">group</span>}
              </span>
              <span className="text-gray-500 truncate">{q.relationship_group || '\u2014'}</span>
              <span className="truncate">
                {q.group_id && groupMap[q.group_id] ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); navigate('/manage/quotes/group/' + q.group_id); }}
                    className="text-ocean-600 hover:text-ocean-700 hover:underline text-xs"
                  >
                    {groupMap[q.group_id]}
                  </button>
                ) : (
                  <span className="text-gray-300">{'\u2014'}</span>
                )}
              </span>
              <span><StatusBadge status={q.status} /></span>
              <span className="text-right font-mono text-ocean-600">{fmt(netGross === 'net' ? q.monthly_net : q.monthly_gross)}</span>
              <span className="text-right font-mono text-gray-500">{fmt(q.annual_total)}</span>
              <div className="text-right">
                <span className="text-gray-500">{new Date(q.created_at).toLocaleDateString('en-GB')}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
