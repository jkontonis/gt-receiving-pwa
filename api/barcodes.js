import { ensureSchema, sql } from './_db.js';

function requireAdminPin(req, res) {
  const expected = process.env.ADMIN_PIN;
  if (!expected) { res.status(500).json({ error: 'Server misconfigured: ADMIN_PIN not set' }); return false; }
  const got = req.headers['x-admin-pin'];
  if (got !== expected) { res.status(401).json({ error: 'Unauthorized — admin PIN required' }); return false; }
  return true;
}

// Two roles in one file (to stay under Vercel Hobby's 12-function cap):
//   - PUBLIC lookup: GET with ?barcode= (or ?action=lookup, set by the /api/lookup
//     rewrite in vercel.json so the iOS app's existing URL keeps working).
//   - ADMIN CRUD:    GET (list) / POST (upsert) / DELETE — all admin-PIN gated.
export default async function handler(req, res) {
  try {
    await ensureSchema();

    if (req.method === 'GET') {
      // Public lookup — triggered by a ?barcode= query (direct calls OR the
      // /api/lookup rewrite that adds ?action=lookup).
      if (req.query.action === 'lookup' || req.query.barcode) {
        const barcode = (req.query.barcode || '').trim();
        if (!barcode) return res.status(400).json({ error: 'barcode is required' });
        const r = await sql`SELECT barcode, product, supplier, unit FROM product_barcodes WHERE barcode = ${barcode}`;
        if (r.length === 0) return res.status(200).json({ found: false, barcode });
        return res.status(200).json({ found: true, ...r[0] });
      }
      // Admin list view
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
