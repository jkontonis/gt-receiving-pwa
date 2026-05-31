// Simple PIN validation endpoint.
// Returns 200 if X-Admin-PIN header matches the ADMIN_PIN env var.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const expected = process.env.ADMIN_PIN;
  if (!expected) {
    return res.status(500).json({ error: 'Server misconfigured: ADMIN_PIN not set' });
  }
  const got = req.headers['x-admin-pin'];
  if (got === expected) {
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ error: 'Unauthorized' });
}
