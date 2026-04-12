const MAKE_WEBHOOK = 'https://hook.eu1.make.com/rn74f5x7bvmp8pol1tpdwac2uk8tsa2i';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const response = await fetch(MAKE_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });

    const text = await response.text();

    return res.status(response.status).send(text);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
