// api/noest-desks.js
// Fetches the list of Noest stop desks (relay points)

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return res.status(403).json({ error: 'Forbidden origin' });
      }
    } catch {
      return res.status(403).json({ error: 'Forbidden origin' });
    }
  }

  const token = process.env.NOEST_API_KEY;
  if (!token) {
    return res.status(500).json({ error: 'Noest API key not configured' });
  }

  try {
    const r = await fetch('https://app.noest-dz.com/api/public/desks', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!r.ok) {
      return res.status(r.status).json({ error: 'Failed to fetch desks from Noest' });
    }

    const data = await r.json();
    // Cache for 1 hour
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
