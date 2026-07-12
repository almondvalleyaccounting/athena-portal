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
import SecurityPage from './shell/SecurityPage';
import DataImportModule from './modules/data-import/DataImportModule';
import SetupModule from './modules/work-planner/setup/SetupModule';
import QboMappingPage from './modules/qbo-mapping/QboMappingPage';
import BillingReviewPage from './modules/billing/BillingReviewPage';
import BillingReviewAndChangePage from './modules/billing/BillingReviewAndChangePage';
import BillingUpliftReviewPage from './modules/billing/BillingUpliftReviewPage';
import BillingSourcesPage from './modules/billing/BillingSourcesPage';
import BillingServiceMappingPage from './modules/billing/BillingServiceMappingPage';
import BillingEmailReconciliationPage from './modules/billing/BillingEmailReconciliationPage';
import BillingAddNewPage from './modules/billing/BillingAddNewPage';
import FeeEarnerBookPage from './modules/billing/FeeEarnerBookPage';
import WorkPlannerModule from './modules/work-planner/WorkPlannerModule';
import JobReviewModule from './modules/job-review/JobReviewModule';
import TimesheetModule from './modules/timesheets/TimesheetModule';
import BillingPage from './modules/billing/BillingPage';
import IssuesPage from './modules/issues/IssuesPage';
import PlanningModule from './modules/planning/PlanningModule';
import ForecastModule from './modules/forecast/ForecastModule';
import PDTrackerModule from './modules/pd-tracker/PDTrackerModule';
import ClientsPage from './modules/clients/ClientsPage';
import OnboardingModule from './modules/onboarding/OnboardingModule';
import ClientDetailView from './modules/clients/ClientDetailView';
import FeeEngineLayout from './contexts/FeeEngineContext';
import AcceptQuotePage from './pages/AcceptQuotePage';
import AdminTasksPage from './pages/AdminTasksPage';

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
        {/* Public routes — rendered outside AppShell, no login required */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/accept-quote" element={<AcceptQuotePage />} />

        {/* Protected shell — all modules render inside AppShell */}
        <Route element={<AppShell />}>
          <Route path="/home" element={<HomeScreen />} />
          <Route path="/ideas" element={<IdeasPage />} />
          <Route path="/bugs" element={<BugReportPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/admin" element={<Navigate to="/admin/staff" replace />} />
          <Route path="/admin/staff" element={<AdminPage />} />
          <Route path="/admin/tasks" element={<AdminTasksPage />} />
          <Route path="/security" element={<SecurityPage />} />
          <Route path="/admin/import/*" element={<DataImportModule />} />
          {/* Legacy Workflow / Staging routes redirect to the new Waiting area. */}
          <Route path="/admin/workflow" element={<Navigate to="/planner/waiting" replace />} />
          <Route path="/admin/workflow/*" element={<Navigate to="/planner/waiting" replace />} />
          <Route path="/workflow" element={<Navigate to="/planner/waiting" replace />} />
          <Route path="/workflow/*" element={<Navigate to="/planner/waiting" replace />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/qbo-mapping" element={<QboMappingPage />} />
          <Route path="/manage/billing/qbo-mapping" element={<QboMappingPage />} />
          <Route path="/manage/billing/review" element={<BillingReviewPage />} />
          <Route path="/manage/billing/change" element={<BillingReviewAndChangePage />} />
          <Route path="/manage/billing/uplifts" element={<BillingUpliftReviewPage />} />
          <Route path="/manage/billing/sources" element={<BillingSourcesPage />} />
          <Route path="/manage/billing/mapping" element={<BillingServiceMappingPage />} />
          <Route path="/manage/billing/emails" element={<BillingEmailReconciliationPage />} />
          <Route path="/manage/billing/add-new" element={<BillingAddNewPage />} />
          <Route path="/manage/billing/fee-earners" element={<FeeEarnerBookPage />} />
          <Route path="/clients/:id" element={<ClientDetailView />} />
          {/* Setup must come before /planner/* wildcard so it matches first. */}
          <Route path="/planner/setup/*" element={<SetupModule />} />
          {/* Job Review lives under Work — must precede the /planner/* wildcard. */}
          <Route path="/planner/review/*" element={<JobReviewModule />} />
          <Route path="/planner/*" element={<WorkPlannerModule />} />
          <Route path="/review" element={<Navigate to="/planner/review" replace />} />
          <Route path="/review/*" element={<Navigate to="/planner/review" replace />} />
          <Route path="/timesheets/*" element={<TimesheetModule />} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/issues" element={<IssuesPage />} />
          <Route path="/planning/*" element={<PlanningModule />} />
          <Route path="/forecast/*" element={<ForecastModule />} />
          <Route path="/team/pd/*" element={<PDTrackerModule />} />
          <Route path="/onboarding/*" element={<OnboardingModule />} />

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
