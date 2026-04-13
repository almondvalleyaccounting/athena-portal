// Apps Script Web App URL — replace after deploying doPost in ControlPanel.gs
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_REPORT_URL || 'DEPLOY_APPS_SCRIPT_AND_SET_ENV_VAR';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (APPS_SCRIPT_URL === 'DEPLOY_APPS_SCRIPT_AND_SET_ENV_VAR') {
    return res.status(503).json({
      error: 'Apps Script Web App URL not configured. Set QBO_REPORTS_SCRIPT_URL in Vercel env vars.',
    });
  }

  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });

    const text = await response.text();

    // Apps Script redirects on exec — follow through and return the final response
    return res.status(response.status).send(text);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
