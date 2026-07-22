import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import VacanciesView from './views/VacanciesView';
import VacancyDetailView from './views/VacancyDetailView';

const font = "'Outfit', sans-serif";

// Recruitment — the firm's in-house applicant-tracking system. Vacancies
// list → open one → pipeline kanban of applicants, with a details tab and
// an advert-tracking tab. Access is RLS-gated (can_view_recruitment for the
// pipeline; applicant PII needs can_view_recruitment_applicants). No public
// surface shares this app — applications arrive by email or manual entry.
export default function RecruitmentModule() {
  return (
    <div style={{ padding: '24px 28px 48px', fontFamily: font, minHeight: '100%', boxSizing: 'border-box' }}>
      <Routes>
        <Route index element={<VacanciesView />} />
        <Route path=":vacancyId" element={<VacancyDetailView />} />
        <Route path="*" element={<Navigate to="/recruitment" replace />} />
      </Routes>
    </div>
  );
}
