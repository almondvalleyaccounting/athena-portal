import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './shell/AppShell';
import LoginPage from './shell/LoginPage';
import HomeScreen from './shell/HomeScreen';
import IdeasPage from './modules/ideas/IdeasPage';
import ReportsPage from './modules/reports/ReportsPage';
import AdminPage from './shell/AdminPage';
import App from './App';
import './index.css';

/*
  Routing strategy:
  - /login       → new cinematic LoginPage (public)
  - /home        → new HomeScreen inside AppShell (protected)
  - /ideas       → IdeasPage inside AppShell (protected)
  - /reports     → ReportsPage inside AppShell (protected)
  - /manage/*    → existing Fee Engine App (has its own auth + NavShell)
  - /            → redirect to /home

  The Fee Engine's App component handles its own session check and
  renders its own NavShell. It is mounted at /manage/* and its internal
  routes (/, /manage/clients, etc.) resolve relative to the full URL.

  App's internal <Route path="/"> matches /manage/ (the base of its mount).
  App's internal <Route path="/manage/clients"> won't match because of
  path stripping — so we mount App without a prefix wrapper and let it
  handle /manage/* paths directly.
*/

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Public route */}
        <Route path="/login" element={<LoginPage />} />

        {/* Protected shell routes */}
        <Route element={<AppShell />}>
          <Route path="/home" element={<HomeScreen />} />
          <Route path="/ideas" element={<IdeasPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Route>

        {/* Root redirect */}
        <Route path="/" element={<Navigate to="/home" replace />} />

        {/* Fee Engine — catch remaining /manage/* routes
            App renders its own <Routes> internally with absolute paths */}
        <Route path="/*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
