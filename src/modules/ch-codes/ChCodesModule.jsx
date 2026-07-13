import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import PipelineView from './views/PipelineView';
import DetailView from './views/DetailView';

/*
  Companies House personal code chase — internal tracking of the CH
  identity-verification code needed from every director/PSC before a
  Confirmation Statement can be filed. Client-facing portal surfaces
  (decision buttons, ID/code upload) arrive in a later phase — for now,
  staff log the client's response here from a phone call or email reply.
*/
export default function ChCodesModule() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', fontFamily: "'Outfit', sans-serif", background: '#fafafa' }}>
      <div style={{ flex: 1 }}>
        <Routes>
          <Route index element={<PipelineView />} />
          <Route path=":id" element={<DetailView />} />
          <Route path="*" element={<Navigate to="/ch-codes" replace />} />
        </Routes>
      </div>
    </div>
  );
}
