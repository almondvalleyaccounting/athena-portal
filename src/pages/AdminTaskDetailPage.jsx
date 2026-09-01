import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import AdminTaskDetail from '../components/AdminTaskDetail';

const font = "'Outfit', sans-serif";

/*
  A task on its own screen at /planner/tasks/:id.

  The admin list no longer sends you here — clicking a row opens the same detail
  in a drawer over the list, which keeps your place in it. This route stays for
  the links that already exist: a bookmark, something pasted into a chat, a
  notification. The body is AdminTaskDetail either way, so the two cannot drift.
*/
export default function AdminTaskDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px 24px 48px', fontFamily: font }}>
      <button onClick={() => navigate('/planner/tasks')}
        style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 13, marginBottom: 16, padding: 0 }}>
        <ChevronLeft size={16} /> Back to Admin tasks
      </button>

      <h1 style={{ margin: '0 0 14px', fontSize: 20, fontWeight: 700, color: '#0f172a' }}>Task detail</h1>

      <AdminTaskDetail taskId={id} />
    </div>
  );
}
