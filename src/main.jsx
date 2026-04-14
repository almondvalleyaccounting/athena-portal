import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './shell/AppShell';
import LoginPage from './shell/LoginPage';
import HomeScreen from './shell/HomeScreen';
import IdeasPage from './modules/ideas/IdeasPage';
import BugReportPage from './modules/bugs/BugReportPage';
import ReportsPage from './modules/reports/ReportsPage';
import AdminPage from './shell/AdminPage';
import WorkPlannerModule from './modules/work-planner/WorkPlannerModule';
import TimesheetModule from './modules/timesheets/TimesheetModule';
import BillingPage from './modules/billing/BillingPage';
import IssuesPage from './modules/issues/IssuesPage';
import ClientsPage from './modules/clients/ClientsPage';
import ClientDetailView from './modules/clients/ClientDetailView';
import FeeEngineLayout from './contexts/FeeEngineContext';

// Fee Engine pages (now render inside AppShell via FeeEngineLayout)
import DashboardPage from './pages/DashboardPage';
import EntitiesPage from './pages/EntitiesPage';
import QuotesPage from './pages/QuotesPage';
import QuoteFormPage from './pages/QuoteFormPage';
import QuoteDetailPage from './pages/QuoteDetailPage';
import PricingDefaultsPage from './pages/PricingDefaultsPage';
import GroupDetailPage from './pages/GroupDetailPage';
import GroupsPage from './pages/GroupsPage';
import GroupQuoteInputPage from './pages/GroupQuoteInputPage';
import ClientDetailPage from './pages/ClientDetailPage';
import AnalysisPage from './pages/AnalysisPage';
import FEBillingPage from './pages/BillingPage';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Public route */}
        <Route path="/login" element={<LoginPage />} />

        {/* Protected shell — all modules render inside AppShell */}
        <Route element={<AppShell />}>
          <Route path="/home" element={<HomeScreen />} />
          <Route path="/ideas" element={<IdeasPage />} />
          <Route path="/bugs" element={<BugReportPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/:id" element={<ClientDetailView />} />
          <Route path="/planner/*" element={<WorkPlannerModule />} />
          <Route path="/timesheets/*" element={<TimesheetModule />} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/issues" element={<IssuesPage />} />

          {/* Fee Engine — wrapped in FeeEngineLayout for defaults context */}
          <Route element={<FeeEngineLayout />}>
            <Route path="/manage" element={<DashboardPage />} />
            <Route path="/manage/clients" element={<EntitiesPage />} />
            <Route path="/manage/clients/:id" element={<ClientDetailPage />} />
            <Route path="/manage/quotes" element={<QuotesPage />} />
            <Route path="/manage/quotes/new" element={<QuoteFormPage mode="new" />} />
            <Route path="/manage/quotes/pricing" element={<PricingDefaultsPage />} />
            <Route path="/manage/quotes/analysis" element={<AnalysisPage />} />
            <Route path="/manage/billing" element={<FEBillingPage />} />
            <Route path="/manage/groups" element={<GroupsPage />} />
            <Route path="/manage/quotes/group/:groupId/quote" element={<GroupQuoteInputPage />} />
            <Route path="/manage/quotes/group/:groupId" element={<GroupDetailPage />} />
            <Route path="/manage/quotes/:id/edit" element={<QuoteFormPage mode="edit" />} />
            <Route path="/manage/quotes/:id" element={<QuoteDetailPage />} />
          </Route>

          {/* Catch-all → home */}
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>

        {/* Root redirect */}
        <Route path="/" element={<Navigate to="/home" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
