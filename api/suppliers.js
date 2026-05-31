import { ensureSchema, sql } from './_db.js';

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
      const r = await sql`SELECT id, name, code, status FROM suppliers ORDER BY name`;
      return res.status(200).json({ suppliers: r });
    }
    if (req.method === 'POST') {
      if (!requireAdminPin(req, res)) return;
      const b = req.body || {};
      if (!b.name) return res.status(400).json({ error: 'name is required' });
      const r = await sql`
        INSERT INTO suppliers (name, code, status)
        VALUES (${b.name}, ${b.code || null}, ${b.status || 'Active'})
        ON CONFLICT (name) DO UPDATE SET
          code = EXCLUDED.code,
          status = EXCLUDED.status
        RETURNING id`;
      return res.status(201).json({ ok: true, id: r[0].id });
    }
    if (req.method === 'PATCH') {
      if (!requireAdminPin(req, res)) return;
      const b = req.body || {};
      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: 'id is required' });
      // If renaming, carry the new name through to receipts + barcode mappings.
      if (b.name) {
        const cur = await sql`SELECT name FROM suppliers WHERE id = ${id}`;
        if (cur.length && cur[0].name !== b.name) {
          await sql`UPDATE receipts SET supplier = ${b.name} WHERE supplier = ${cur[0].name}`;
          await sql`UPDATE product_barcodes SET supplier = ${b.name} WHERE supplier = ${cur[0].name}`;
        }
      }
      await sql`UPDATE suppliers SET
        name = COALESCE(${b.name}, name),
        code = COALESCE(${b.code}, code),
        status = COALESCE(${b.status}, status)
        WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'DELETE') {
      if (!requireAdminPin(req, res)) return;
      const id = parseInt((req.query && req.query.id) || (req.body && req.body.id) || '', 10);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const r = await sql`DELETE FROM suppliers WHERE id = ${id} RETURNING id`;
      if (r.length === 0) return res.status(404).json({ error: 'Supplier not found' });
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
