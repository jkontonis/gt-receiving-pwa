import { ensureSchema, sql, lotCodeFor } from './_db.js';

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
function strOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();

    // -----------------------------------------------------------------------
    // POST — create a RECEIVED lot (incoming WIP from a supplier delivery).
    // Staff-facing, no admin PIN. Captures the supplier kill date + UBD so they
    // can be carried down when the lot is later boned out.
    // -----------------------------------------------------------------------
    if (req.method === 'POST') {
      const b = req.body || {};
      const product = strOrNull(b.product);
      if (!product) return res.status(400).json({ error: 'Missing required field: product' });

      const productionDate = strOrNull(b.production_date) || strOrNull(b.received_on)
        || new Date().toISOString().slice(0, 10);
      const qty = numOrNull(b.quantity);
      const weight = numOrNull(b.weight_kg);
      if (qty === null && weight === null) {
        return res.status(400).json({ error: 'Enter a quantity or a weight.' });
      }

      // Make sure the product exists (so later processing knows its shelf life).
      await sql`INSERT INTO products (canonical_name, unit, kind)
                VALUES (${product}, ${strOrNull(b.unit)}, 'raw')
                ON CONFLICT (canonical_name) DO NOTHING`;

      const status = strOrNull(b.status) || 'available';
      const inserted = await sql`
        INSERT INTO lots
          (lot_code, product, origin, status, supplier, supplier_batch,
           kill_date, production_date, use_by, quantity, unit, weight_kg,
           container, receipt_id, notes)
        VALUES
          ('PENDING', ${product}, 'received', ${status}, ${strOrNull(b.supplier)},
           ${strOrNull(b.supplier_batch)}, ${strOrNull(b.kill_date)}, ${productionDate},
           ${strOrNull(b.use_by)}, ${qty}, ${strOrNull(b.unit)}, ${weight},
           ${strOrNull(b.container)}, ${numOrNull(b.receipt_id)}, ${strOrNull(b.notes)})
        RETURNING *`;
      const lot = inserted[0];
      const code = strOrNull(b.lot_code) || lotCodeFor(productionDate, lot.id);
      const updated = await sql`UPDATE lots SET lot_code = ${code} WHERE id = ${lot.id} RETURNING *`;
      return res.status(201).json({ lot: updated[0] });
    }

    // -----------------------------------------------------------------------
    // GET — list lots (?status= ?product= ?origin= ?q= ?days=) or one (?id=).
    // -----------------------------------------------------------------------
    if (req.method === 'GET') {
      const { id, status, product, origin, q, days } = req.query;

      if (id) {
        const rows = await sql`SELECT * FROM lots WHERE id = ${Number(id)}`;
        if (rows.length === 0) return res.status(404).json({ error: 'Lot not found' });
        return res.status(200).json({ lot: rows[0] });
      }

      const d = Math.min(Math.max(parseInt(days || '90', 10) || 90, 1), 3650);
      const since = new Date(Date.now() - d * 86400000).toISOString();
      const like = q ? `%${String(q)}%` : null;
      const st = status || null;
      const pr = product || null;
      const og = origin || null;
      const rows = await sql`
        SELECT * FROM lots
        WHERE created_at >= ${since}
          AND (${st}::text IS NULL OR status = ${st})
          AND (${pr}::text IS NULL OR product = ${pr})
          AND (${og}::text IS NULL OR origin = ${og})
          AND (${like}::text IS NULL OR lot_code ILIKE ${like}
               OR product ILIKE ${like} OR COALESCE(supplier,'') ILIKE ${like}
               OR COALESCE(supplier_batch,'') ILIKE ${like})
        ORDER BY created_at DESC
        LIMIT 500`;
      return res.status(200).json({ lots: rows });
    }

    // -----------------------------------------------------------------------
    // PATCH / DELETE — admin-gated corrections.
    // -----------------------------------------------------------------------
    if (req.method === 'PATCH') {
      if (!requireAdminPin(req, res)) return;
      const b = req.body || {};
      const id = Number(b.id);
      if (!id) return res.status(400).json({ error: 'Missing id' });
      // COALESCE-merge pattern: only the keys present in the body change; a
      // missing key keeps the existing value, an explicit null clears it.
      const has = (k) => k in b;
      const val = (k) => (b[k] === '' ? null : b[k]);
      if (!['status', 'use_by', 'weight_kg', 'quantity', 'notes', 'container'].some(has)) {
        return res.status(400).json({ error: 'Nothing to update' });
      }
      const rows = await sql`
        UPDATE lots SET
          status    = CASE WHEN ${has('status')}    THEN ${val('status')}           ELSE status    END,
          use_by    = CASE WHEN ${has('use_by')}    THEN ${val('use_by')}::date    ELSE use_by    END,
          weight_kg = CASE WHEN ${has('weight_kg')} THEN ${val('weight_kg')}::numeric ELSE weight_kg END,
          quantity  = CASE WHEN ${has('quantity')}  THEN ${val('quantity')}::numeric  ELSE quantity END,
          notes     = CASE WHEN ${has('notes')}     THEN ${val('notes')}             ELSE notes     END,
          container = CASE WHEN ${has('container')} THEN ${val('container')}         ELSE container END
        WHERE id = ${id}
        RETURNING *`;
      if (rows.length === 0) return res.status(404).json({ error: 'Lot not found' });
      return res.status(200).json({ lot: rows[0] });
    }

    if (req.method === 'DELETE') {
      if (!requireAdminPin(req, res)) return;
      const id = Number(req.query.id || (req.body || {}).id);
      if (!id) return res.status(400).json({ error: 'Missing id' });
      await sql`DELETE FROM lots WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('lots error', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
