import React from 'react';
import { BarChart2 } from 'lucide-react';

export default function ReportsPage() {
  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '40px 24px' }}>
      <h1
        style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: '28px',
          fontWeight: 500,
          color: '#0f172a',
          marginBottom: '8px',
        }}
      >
        Reports
      </h1>
      <p
        style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: '14px',
          color: '#64748b',
          marginBottom: '48px',
        }}
      >
        Practice analytics and reporting.
      </p>

      <div
        style={{
          textAlign: 'center',
          padding: '60px 0',
        }}
      >
        <BarChart2
          size={36}
          style={{ color: '#e5e7eb', margin: '0 auto 16px' }}
        />
        <p
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '15px',
            fontWeight: 500,
            color: '#94a3b8',
            marginBottom: '4px',
          }}
        >
          Coming soon
        </p>
        <p
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '13px',
            color: '#cbd5e1',
          }}
        >
          Reports and dashboards are in development.
        </p>
      </div>
    </div>
  );
}
