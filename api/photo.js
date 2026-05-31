import { ensureSchema, sql } from './_db.js';

// Returns the stored photo data URL for a single receipt. Kept separate from the
// list endpoints so they stay light (photos are not sent in bulk).
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await ensureSchema();
    const id = parseInt(req.query.id || '', 10);
    if (!id) return res.status(400).json({ error: 'id is required' });
    const r = await sql`SELECT photo FROM receipts WHERE id = ${id}`;
    if (r.length === 0 || !r[0].photo) return res.status(404).json({ error: 'No photo' });
    return res.status(200).json({ photo: r[0].photo });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
