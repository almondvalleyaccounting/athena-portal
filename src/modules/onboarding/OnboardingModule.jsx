import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import PipelineView from './views/PipelineView';
import NewOnboardingView from './views/NewOnboardingView';
import OnboardingDetailView from './views/OnboardingDetailView';
import UpdatesView from './views/UpdatesView';
import BoardView from './views/BoardView';
import CrossCheckView from './views/CrossCheckView';
import ChPipelineView from '../ch-codes/views/PipelineView';
import ChDetailView from '../ch-codes/views/DetailView';
import ChQueueView from '../ch-codes/views/QueueView';
import ChTemplatesView from '../ch-codes/views/TemplatesView';
import ChDashboardView from '../ch-codes/views/DashboardView';

/*
  Onboarding module — internal tracking of new-client / new-service
  onboarding, replacing the BrightManager workflows + manual spreadsheet.
  Client-facing portal surfaces arrive in a later phase.
*/
export default function OnboardingModule() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', minHeight: '100%',
      fontFamily: "'Outfit', sans-serif", background: '#fafafa',
    }}>
      <div style={{ flex: 1 }}>
        <Routes>
          <Route index element={<PipelineView />} />
          {/* Same view as the index — a distinct path so the sidebar can
              highlight List without matching every /onboarding/* route. */}
          <Route path="list" element={<PipelineView />} />
          <Route path="new" element={<NewOnboardingView />} />
          <Route path="updates" element={<UpdatesView />} />
          <Route path="board" element={<BoardView />} />
          <Route path="cross-check" element={<CrossCheckView />} />
          {/* CH personal-code chase — rolled in as a sub-tab of onboarding */}
          <Route path="ch-codes" element={<ChPipelineView />} />
          <Route path="ch-codes/dashboard" element={<ChDashboardView />} />
          <Route path="ch-codes/queue" element={<ChQueueView />} />
          <Route path="ch-codes/templates" element={<ChTemplatesView />} />
          <Route path="ch-codes/:id" element={<ChDetailView />} />
          <Route path=":id" element={<OnboardingDetailView />} />
          <Route path="*" element={<Navigate to="/onboarding" replace />} />
        </Routes>
      </div>
    </div>
  );
}
