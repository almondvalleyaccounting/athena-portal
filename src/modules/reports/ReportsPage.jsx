import React, { useState } from 'react';
import ReportForm from './ReportForm';
import RunLog from './RunLog';

export default function ReportsPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="mx-auto" style={{ maxWidth: '1080px', padding: '40px 24px' }}>
      <h1
        className="mb-1"
        style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: '28px',
          fontWeight: 500,
          color: '#0f172a',
        }}
      >
        Reports
      </h1>
      <p className="mb-8" style={{ fontSize: '14px', color: '#64748b' }}>
        Pull financial reports from QuickBooks Online.
      </p>

      <div className="flex flex-col md:flex-row gap-10">
        {/* Left column — Report builder (60%) */}
        <div className="w-full md:w-3/5">
          <ReportForm onSuccess={() => setRefreshKey((k) => k + 1)} />
        </div>

        {/* Right column — Run log (40%) */}
        <div className="w-full md:w-2/5">
          <RunLog refreshKey={refreshKey} />
        </div>
      </div>
    </div>
  );
}
