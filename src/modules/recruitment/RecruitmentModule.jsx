import React from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { pillStyle } from '../../lib/tokens';
import VacanciesView from './views/VacanciesView';
import VacancyDetailView from './views/VacancyDetailView';
import InterviewsView from './views/InterviewsView';

const font = "'Outfit', sans-serif";

const TABS = [
  { path: '/recruitment', label: 'Vacancies', match: (p) => p === '/recruitment' || (p.startsWith('/recruitment/') && p !== '/recruitment/interviews') },
  { path: '/recruitment/interviews', label: 'Interviews', match: (p) => p === '/recruitment/interviews' },
];

// Recruitment — the firm's in-house applicant-tracking system. Vacancies
// list → open one → pipeline kanban of applicants, with per-applicant comms,
// interviews, offer, contract and induction. RLS-gated (can_view_recruitment
// for the pipeline; applicant PII needs can_view_recruitment_applicants). No
// public surface shares this app — applications arrive by email or manual entry.
export default function RecruitmentModule() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div style={{ padding: '24px 28px 48px', fontFamily: font, minHeight: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, maxWidth: 1180, marginLeft: 'auto', marginRight: 'auto' }}>
        {TABS.map((t) => (
          <button key={t.path} onClick={() => navigate(t.path)}
            style={pillStyle({ tone: 'info', active: t.match(location.pathname) })}>
            {t.label}
          </button>
        ))}
      </div>
      <Routes>
        <Route index element={<VacanciesView />} />
        <Route path="interviews" element={<InterviewsView />} />
        <Route path=":vacancyId" element={<VacancyDetailView />} />
        <Route path="*" element={<Navigate to="/recruitment" replace />} />
      </Routes>
    </div>
  );
}
