import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import PipelineView from './views/PipelineView';
import NewOnboardingView from './views/NewOnboardingView';
import OnboardingDetailView from './views/OnboardingDetailView';

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
          <Route path="new" element={<NewOnboardingView />} />
          <Route path=":id" element={<OnboardingDetailView />} />
          <Route path="*" element={<Navigate to="/onboarding" replace />} />
        </Routes>
      </div>
    </div>
  );
}
