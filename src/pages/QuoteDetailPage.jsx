import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Btn } from '../components/ui';

export default function QuoteDetailPage({ profile }) {
  const { id } = useParams();
  const navigate = useNavigate();

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold text-ocean-700">Quote Detail</h2>
        <Btn onClick={() => navigate('/manage/quotes')} variant="ghost">Back to Quotes</Btn>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
        <p className="text-sm text-gray-400">Quote detail view — building in Step 5...</p>
        <p className="text-xs text-gray-300 mt-1">ID: {id}</p>
      </div>
    </div>
  );
}
