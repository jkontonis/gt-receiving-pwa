import { ensureSchema, sql } from './_db.js';

function requireAdminPin(req, res) {
  const expected = process.env.ADMIN_PIN;
  if (!expected) { res.status(500).json({ error: 'Server misconfigured: ADMIN_PIN not set' }); return false; }
  const got = req.headers['x-admin-pin'];
  if (got !== expected) { res.status(401).json({ error: 'Unauthorized — admin PIN required' }); return false; }
  return true;
}

// Admin management of the learned barcode -> product map. The receive flow learns
// mappings automatically; this lets John review, correct, or delete them.
export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (req.method === 'GET') {
      if (!requireAdminPin(req, res)) return;
      const r = await sql`SELECT barcode, product, supplier, unit, created_at
        FROM product_barcodes ORDER BY product, barcode`;
      return res.status(200).json({ barcodes: r });
    }
    if (req.method === 'POST') {
      if (!requireAdminPin(req, res)) return;
      const b = req.body || {};
      if (!b.barcode || !b.product) return res.status(400).json({ error: 'barcode and product are required' });
      await sql`INSERT INTO product_barcodes (barcode, product, supplier, unit)
        VALUES (${String(b.barcode).trim()}, ${b.product}, ${b.supplier || null}, ${b.unit || null})
        ON CONFLICT (barcode) DO UPDATE SET
          product = EXCLUDED.product,
          supplier = EXCLUDED.supplier,
          unit = EXCLUDED.unit`;
      return res.status(201).json({ ok: true });
    }
    if (req.method === 'DELETE') {
      if (!requireAdminPin(req, res)) return;
      const barcode = (req.query && req.query.barcode) || (req.body && req.body.barcode);
      if (!barcode) return res.status(400).json({ error: 'barcode is required' });
      const r = await sql`DELETE FROM product_barcodes WHERE barcode = ${barcode} RETURNING barcode`;
      if (r.length === 0) return res.status(404).json({ error: 'Barcode not found' });
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
