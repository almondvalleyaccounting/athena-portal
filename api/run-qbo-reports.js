const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_REPORT_URL || '';
const PORTAL_SYNC_SECRET = process.env.PORTAL_SYNC_SECRET || '';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!APPS_SCRIPT_URL) {
    return res.status(503).json({
      error: 'APPS_SCRIPT_REPORT_URL not configured in Vercel env vars.',
    });
  }

  try {
    // Include auth token — Apps Script doPost validates it
    const payload = {
      ...req.body,
      auth: PORTAL_SYNC_SECRET ? `Bearer ${PORTAL_SYNC_SECRET}` : '',
    };

    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    const text = await response.text();

    // Log for debugging
    console.log('Apps Script response:', response.status, text.substring(0, 500));

    return res.status(response.status).send(text);
  } catch (e) {
    console.error('Proxy error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
