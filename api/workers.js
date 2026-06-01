import { ensureSchema, sql } from './_db.js';

// Worker / operator register — the "who" for audit defence. GET is open (the app
// needs the list to populate the required operator dropdown); writes are admin-PIN
// gated. worker_id can mirror the staff codes on the paper GT-QC-00 form.

function requireAdminPin(req, res) {
  const expected = process.env.ADMIN_PIN;
  if (!expected) { res.status(500).json({ error: 'Server misconfigured: ADMIN_PIN not set' }); return false; }
  const got = req.headers['x-admin-pin'];
  if (got !== expected) { res.status(401).json({ error: 'Unauthorized — admin PIN required' }); return false; }
  return true;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();

    if (req.method === 'GET') {
      const r = await sql`SELECT id, worker_id, name, status FROM workers ORDER BY name`;
      return res.status(200).json({ workers: r });
    }

    if (req.method === 'POST') {
      if (!requireAdminPin(req, res)) return;
      const b = req.body || {};
      if (!b.worker_id || !b.name) {
        return res.status(400).json({ error: 'worker_id and name are required' });
      }
      const r = await sql`
        INSERT INTO workers (worker_id, name, status)
        VALUES (${b.worker_id}, ${b.name}, ${b.status || 'Active'})
        ON CONFLICT (worker_id) DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status
        RETURNING id`;
      return res.status(201).json({ ok: true, id: r[0].id });
    }

    if (req.method === 'DELETE') {
      if (!requireAdminPin(req, res)) return;
      const id = parseInt((req.query && req.query.id) || (req.body && req.body.id) || '', 10);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const r = await sql`DELETE FROM workers WHERE id = ${id} RETURNING id`;
      if (r.length === 0) return res.status(404).json({ error: 'Worker not found' });
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
