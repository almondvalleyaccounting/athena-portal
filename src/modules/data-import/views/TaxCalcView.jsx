import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../shell/AppShell';
import TaxBatchUpload from '../../reminders/TaxBatchUpload';

const font = "'Outfit', sans-serif";

/*
  TaxCalc import — upload a TaxCalc report (CSV) of personal-tax payments
  due. The shared upload flow (TaxBatchUpload) parses the file, maps the
  columns, auto-matches rows to clients and saves the batch; the batch is
  then worked from Client Reminders, where opt-ins and reminder emails
  are managed.
*/

export default function TaxCalcView() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [entities, setEntities] = useState(null);
  const [ignoreUtrs, setIgnoreUtrs] = useState([]);
  const [error, setError] = useState(null);
  const [savedBatchId, setSavedBatchId] = useState(null);

  useEffect(() => {
    (async () => {
      const [{ data, error: e }, { data: ign }] = await Promise.all([
        supabase.from('entities').select('id, name, utr').order('name'),
        supabase.from('tax_reminder_ignore').select('utr'),
      ]);
      if (e) { setError(`Could not load clients: ${e.message}`); return; }
      setEntities(data || []);
      setIgnoreUtrs((ign || []).map((r) => r.utr));
    })();
  }, []);

  return (
    <div style={{ padding: '24px 28px', fontFamily: font, maxWidth: 900 }}>
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24 }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', margin: 0 }}>
          TaxCalc import
        </h2>
        <p style={{ fontSize: 13, color: '#64748b', margin: '8px 0 20px' }}>
          Upload a TaxCalc / POA report (.xlsx or .csv) of personal-tax payments due — e.g. July
          payments on account. Only rows with a payment-on-account amount import, and each is matched
          to a client by <strong>UTR + surname</strong>. Unmatched rows still import; you match or
          exclude them by hand in <strong>Client Reminders</strong> after saving, where opt-in
          invitations and payment reminders are then sent.
        </p>

        {error && (
          <div style={{
            padding: '9px 12px', background: '#fef2f2', border: '1px solid #fecaca',
            borderRadius: 8, fontSize: 12.5, color: '#b91c1c', marginBottom: 12,
          }}>
            {error}
          </div>
        )}

        {savedBatchId && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
            background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8,
            fontSize: 12.5, color: '#166534', marginBottom: 12,
          }}>
            <span style={{ flex: 1 }}>
              Batch saved —{' '}
              <button
                onClick={() => navigate('/comms/reminders')}
                style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  fontFamily: font, fontSize: 12.5, fontWeight: 600, color: '#166534',
                  textDecoration: 'underline',
                }}
              >
                open Client Reminders →
              </button>
            </span>
          </div>
        )}

        {entities === null && !error && (
          <div style={{ fontSize: 13, color: '#94a3b8' }}>Loading clients…</div>
        )}
        {entities !== null && (
          <TaxBatchUpload
            entities={entities}
            ignoreUtrs={ignoreUtrs}
            profileId={profile?.id}
            onSaved={(id) => setSavedBatchId(id)}
          />
        )}
      </div>
    </div>
  );
}
