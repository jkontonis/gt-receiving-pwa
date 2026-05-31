import { ensureSchema, sql } from './_db.js';

// Resolve a scanned supplier barcode to one of our products. Open (no PIN) — the
// receive page calls this right after a scan to auto-fill product/supplier/unit.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await ensureSchema();
    const barcode = (req.query.barcode || '').trim();
    if (!barcode) return res.status(400).json({ error: 'barcode is required' });
    const r = await sql`SELECT barcode, product, supplier, unit FROM product_barcodes WHERE barcode = ${barcode}`;
    if (r.length === 0) return res.status(200).json({ found: false, barcode });
    return res.status(200).json({ found: true, ...r[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
