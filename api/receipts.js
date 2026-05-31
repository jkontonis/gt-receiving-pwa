import { ensureSchema, sql } from './_db.js';

function requireAdminPin(req, res) {
  const expected = process.env.ADMIN_PIN;
  if (!expected) { res.status(500).json({ error: 'Server misconfigured: ADMIN_PIN not set' }); return false; }
  const got = req.headers['x-admin-pin'];
  if (got !== expected) { res.status(401).json({ error: 'Unauthorized — admin PIN required' }); return false; }
  return true;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();

    // POST — staff-facing receive endpoint. No admin PIN required.
    if (req.method === 'POST') {
      const b = req.body || {};
      const required = ['received_on', 'product'];
      for (const f of required) {
        if (!b[f]) return res.status(400).json({ error: `Missing required field: ${f}` });
      }
      const qty = numOrNull(b.quantity);
      const weight = numOrNull(b.weight_kg);
      if (qty === null && weight === null) {
        return res.status(400).json({ error: 'Enter a quantity or a weight.' });
      }
      let photo = b.photo || null;
      if (photo && typeof photo === 'string' && photo.length > 600 * 1024) {
        return res.status(413).json({ error: 'Photo too large — please retake.' });
      }

      const productName = String(b.product).trim();
      const supplier = b.supplier ? String(b.supplier).trim() : null;
      const unit = b.unit ? String(b.unit).trim() : null;
      const barcode = b.barcode ? String(b.barcode).trim() : null;

      // Keep the product master in sync with whatever staff actually receive.
      await sql`INSERT INTO products (canonical_name) VALUES (${productName})
                ON CONFLICT (canonical_name) DO NOTHING`;

      // Learn the barcode -> product mapping so next scan auto-fills. Idempotent;
      // a re-scan of a known barcode refreshes the product/supplier/unit it maps to.
      if (barcode) {
        await sql`INSERT INTO product_barcodes (barcode, product, supplier, unit)
                  VALUES (${barcode}, ${productName}, ${supplier}, ${unit})
                  ON CONFLICT (barcode) DO UPDATE SET
                    product = EXCLUDED.product,
                    supplier = COALESCE(EXCLUDED.supplier, product_barcodes.supplier),
                    unit = COALESCE(EXCLUDED.unit, product_barcodes.unit)`;
      }

      const result = await sql`
        INSERT INTO receipts (received_on, received_ts, barcode, product, supplier, quantity, unit, weight_kg, batch_number, use_by, notes, client_id, photo)
        VALUES (${b.received_on}, ${b.received_ts || null}, ${barcode}, ${productName}, ${supplier}, ${qty}, ${unit}, ${weight}, ${b.batch_number || null}, ${b.use_by || null}, ${b.notes || null}, ${b.client_id || null}, ${photo})
        RETURNING id, created_at
      `;
      return res.status(200).json({ ok: true, id: result[0].id, created_at: result[0].created_at });
    }

    // GET — recent receipts. Open to the floor (no PIN) so staff can check what's
    // already been booked in. Supports ?days= and ?q= (batch/product/supplier search).
    if (req.method === 'GET') {
      const days = Math.min(Math.max(parseInt(req.query.days || '14', 10) || 14, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const q = (req.query.q || '').trim();
      let rows;
      if (q) {
        const like = `%${q}%`;
        rows = await sql`
          SELECT id, created_at, received_on, received_ts, barcode, product, supplier,
                 quantity, unit, weight_kg, batch_number, use_by, notes,
                 (photo IS NOT NULL) AS has_photo
          FROM receipts
          WHERE received_on >= ${since}
            AND (batch_number ILIKE ${like} OR product ILIKE ${like} OR supplier ILIKE ${like} OR barcode ILIKE ${like})
          ORDER BY id DESC LIMIT 200`;
      } else {
        rows = await sql`
          SELECT id, created_at, received_on, received_ts, barcode, product, supplier,
                 quantity, unit, weight_kg, batch_number, use_by, notes,
                 (photo IS NOT NULL) AS has_photo
          FROM receipts
          WHERE received_on >= ${since}
          ORDER BY id DESC LIMIT 200`;
      }
      return res.status(200).json({ receipts: rows, days });
    }

    if (req.method === 'PATCH') {
      if (!requireAdminPin(req, res)) return;
      const b = req.body || {};
      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const removePhoto = b.remove_photo === true;
      await sql`UPDATE receipts SET
        received_on  = COALESCE(${b.received_on}, received_on),
        barcode      = COALESCE(${b.barcode}, barcode),
        product      = COALESCE(${b.product}, product),
        supplier     = COALESCE(${b.supplier}, supplier),
        quantity     = COALESCE(${numOrNull(b.quantity)}, quantity),
        unit         = COALESCE(${b.unit}, unit),
        weight_kg    = COALESCE(${numOrNull(b.weight_kg)}, weight_kg),
        batch_number = COALESCE(${b.batch_number}, batch_number),
        use_by       = COALESCE(${b.use_by}, use_by),
        notes        = COALESCE(${b.notes}, notes),
        photo        = CASE WHEN ${removePhoto} THEN NULL ELSE photo END
        WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if (!requireAdminPin(req, res)) return;
      const id = parseInt((req.query && req.query.id) || (req.body && req.body.id) || '', 10);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const r = await sql`DELETE FROM receipts WHERE id = ${id} RETURNING id`;
      if (r.length === 0) return res.status(404).json({ error: 'Receipt not found' });
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
