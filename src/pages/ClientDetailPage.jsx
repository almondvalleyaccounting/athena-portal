import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';
import { useAuth } from '../shell/AppShell';

export default function ClientDetailPage() {
  const { profile } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const [entity, setEntity] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [{ data: ent }, { data: qs }] = await Promise.all([
        supabase.from('entities').select('*').eq('id', id).single(),
        supabase.from('quotes').select('*').eq('entity_id', id).order('created_at', { ascending: false }),
      ]);
      setEntity(ent);
      setQuotes(qs || []);
      setLoading(false);
    })();
  }, [id]);

  const handleRename = async () => {
    if (!editName.trim() || editName.trim() === entity.name) { setEditing(false); return; }
    setSaving(true);
    await supabase.from('entities').update({ name: editName.trim() }).eq('id', entity.id);
    setEntity({ ...entity, name: editName.trim() });
    setEditing(false);
    setSaving(false);
  };

  const [deleting, setDeleting] = useState(false);

  const handleDeleteClient = async () => {
    if (!window.confirm('Delete client "' + entity.name + '"? This will remove the client record. Quotes linked to this client will remain but lose their client link. This cannot be undone.')) return;
    setDeleting(true);
    try {
      await supabase.from('billing_group_members').delete().eq('entity_id', entity.id);
      const { error } = await supabase.from('entities').delete().eq('id', entity.id);
      if (error) throw error;
      navigate('/manage/clients');
    } catch (err) {
      alert('Failed to delete: ' + (err.message || 'Unknown error'));
      setDeleting(false);
    }
  };

  if (loading) return <div className="p-6"><p className="text-sm text-gray-400">Loading client...</p></div>;
  if (!entity) return <div className="p-6"><p className="text-sm text-red-500">Client not found.</p></div>;

  const totalMonthly = quotes
    .filter(q => q.status === 'accepted' || q.status === 'sent' || q.status === 'approved')
    .reduce((s, q) => s + (Number(q.monthly_gross) || 0), 0);

  return (
    <div className="p-6 max-w-3xl">
      {/* Header */}
      <div className="flex justify-between items-start mb-4">
        <div>
          {editing ? (
            <div className="flex items-center gap-2 mb-1">
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditing(false); }}
                className="text-lg font-bold text-ocean-700 border border-ocean-300 rounded px-2 py-0.5 w-64"
                autoFocus
              />
              <Btn onClick={handleRename} disabled={saving} variant="secondary" className="text-xs py-1 px-2">{saving ? '...' : 'Save'}</Btn>
              <button onClick={() => setEditing(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
            </div>
          ) : (
            <h2 className="text-lg font-bold text-ocean-700 cursor-pointer hover:text-ocean-500 group" onClick={() => { setEditName(entity.name); setEditing(true); }}>
              {entity.name}
              <span className="text-xs text-gray-300 font-normal ml-2 opacity-0 group-hover:opacity-100 transition-opacity">edit</span>
            </h2>
          )}
          <p className="text-xs text-gray-400">
            {entity.type?.replace('_', ' ')}
            {entity.company_number ? ` \u00B7 ${entity.company_number}` : ''}
            {entity.entity_status ? ` \u00B7 ${entity.entity_status}` : ''}
          </p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={async () => {
                const next = !entity.expedite;
                const prev = entity.expedite;
                setEntity({ ...entity, expedite: next });
                const { error } = await supabase.from('entities').update({ expedite: next }).eq('id', entity.id);
                if (error) {
                  alert('Could not update expedite flag: ' + error.message);
                  setEntity({ ...entity, expedite: prev });
                }
              }}
              title={entity.expedite ? 'Expedite ON \u2014 work prioritised post-period-end. Click to turn off.' : 'Expedite OFF. Click to flag this client for fast turnaround.'}
              className={`text-[10px] font-bold tracking-wide uppercase px-2 py-0.5 rounded border ${
                entity.expedite
                  ? 'bg-amber-100 text-amber-700 border-amber-300'
                  : 'bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200'
              }`}
            >
              {entity.expedite ? '\u26A1 Expedite' : 'Expedite off'}
            </button>
            {entity.grade && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200" title="Client grade (imported)">
                Grade {entity.grade}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Btn onClick={() => navigate('/manage/quotes/new?entity=' + entity.id)}>New Quote</Btn>
          <Btn onClick={() => navigate('/manage/clients')} variant="ghost">Back</Btn>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <p className="text-xs text-gray-400 mb-1">Quotes</p>
          <p className="text-xl font-bold text-ocean-700 font-mono">{quotes.length}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <p className="text-xs text-gray-400 mb-1">Active Monthly</p>
          <p className="text-xl font-bold text-ocean-700 font-mono">{fmt(totalMonthly)}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <p className="text-xs text-gray-400 mb-1">Status</p>
          <p className="text-sm font-medium text-gray-700 capitalize">{entity.entity_status || 'prospect'}</p>
        </div>
      </div>

      {/* Client details */}
      {(entity.utr || entity.vat_number || entity.paye_ref || entity.company_number) && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Details</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {entity.company_number && <><span className="text-gray-400">Company Number</span><span className="text-gray-700">{entity.company_number}</span></>}
            {entity.utr && <><span className="text-gray-400">UTR</span><span className="text-gray-700">{entity.utr}</span></>}
            {entity.vat_number && <><span className="text-gray-400">VAT Number</span><span className="text-gray-700">{entity.vat_number}</span></>}
            {entity.paye_ref && <><span className="text-gray-400">PAYE Ref</span><span className="text-gray-700">{entity.paye_ref}</span></>}
            {entity.manager && <><span className="text-gray-400">Manager</span><span className="text-gray-700">{entity.manager}</span></>}
            {entity.grade && <><span className="text-gray-400">Grade</span><span className="text-gray-700">{entity.grade}</span></>}
            <><span className="text-gray-400">Expedite</span><span className="text-gray-700">{entity.expedite ? 'Yes — prioritise post-period-end' : 'No'}</span></>
          </div>
        </div>
      )}

      {/* Quotes list */}
      <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Quotes</h3>
      {quotes.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-400 mb-2">No quotes for this client yet.</p>
          <Btn onClick={() => navigate('/manage/quotes/new?entity=' + entity.id)}>Create Quote</Btn>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {quotes.map(q => (
            <div
              key={q.id}
              onClick={() => navigate('/manage/quotes/' + q.id)}
              className="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer"
            >
              <div>
                <p className="text-sm font-medium text-gray-700">{q.quote_ref}</p>
                <p className="text-xs text-gray-400">
                  {new Date(q.created_at).toLocaleDateString('en-GB')}
                  {q.valid_until && ` \u00B7 Valid until ${new Date(q.valid_until).toLocaleDateString('en-GB')}`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-mono text-ocean-600">{fmt(q.monthly_gross)}</span>
                <StatusBadge status={q.status} />
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Delete */}
      <div className="mt-6 pt-4 border-t border-gray-200">
        <Btn onClick={handleDeleteClient} variant="danger" disabled={deleting}>
          {deleting ? 'Deleting...' : 'Delete Client'}
        </Btn>
      </div>
    </div>
  );
}
