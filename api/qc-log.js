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

    // POST — staff-facing log endpoint. No PIN. Mirrors the QC PWA's /api/log
    // behaviour including the auto-create of unknown products in the SKU master.
    if (req.method === 'POST') {
      const b = req.body || {};
      const required = ['occurred_at', 'product', 'stage', 'worker_code', 'error_type'];
      for (const f of required) {
        if (!b[f]) return res.status(400).json({ error: `Missing required field: ${f}` });
      }
      let photo = b.photo || null;
      if (photo && typeof photo === 'string' && photo.length > 600 * 1024) {
        return res.status(413).json({ error: 'Photo too large — please retake.' });
      }
      const productName = String(b.product).trim();
      // Auto-create the product in the shared SKU master if it isn't there yet.
      // Same idempotent pattern as the receipts/lots flows use elsewhere.
      await sql`INSERT INTO products (canonical_name) VALUES (${productName})
                ON CONFLICT (canonical_name) DO NOTHING`;
      const result = await sql`
        INSERT INTO qc_errors (occurred_at, order_number, customer, product, stage, worker_code, error_type, caught_by, action_taken, notes, client_id, photo, site_id)
        VALUES (${b.occurred_at}, ${b.order_number || null}, ${b.customer || null}, ${productName}, ${b.stage}, ${b.worker_code}, ${b.error_type}, ${b.caught_by || null}, ${b.action_taken || null}, ${b.notes || null}, ${b.client_id || null}, ${photo}, ${b.site_id || null})
        RETURNING id, created_at
      `;
      return res.status(200).json({ ok: true, id: result[0].id, created_at: result[0].created_at });
    }

    // GET, PATCH, DELETE are admin-only.
    if (req.method === 'GET') {
      if (!requireAdminPin(req, res)) return;
      const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const rows = await sql`
        SELECT id, created_at, occurred_at, order_number, customer, product, stage,
               worker_code, error_type, caught_by, action_taken, notes, site_id,
               (photo IS NOT NULL) AS has_photo
        FROM qc_errors WHERE occurred_at >= ${since}
        ORDER BY id DESC LIMIT 100
      `;
      return res.status(200).json({ errors: rows, days });
    }

    if (req.method === 'PATCH') {
      if (!requireAdminPin(req, res)) return;
      const b = req.body || {};
      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const removePhoto = b.remove_photo === true;
      await sql`UPDATE qc_errors SET
        occurred_at  = COALESCE(${b.occurred_at}, occurred_at),
        order_number = COALESCE(${b.order_number}, order_number),
        customer     = COALESCE(${b.customer}, customer),
        product      = COALESCE(${b.product}, product),
        stage        = COALESCE(${b.stage}, stage),
        worker_code  = COALESCE(${b.worker_code}, worker_code),
        error_type   = COALESCE(${b.error_type}, error_type),
        caught_by    = COALESCE(${b.caught_by}, caught_by),
        action_taken = COALESCE(${b.action_taken}, action_taken),
        notes        = COALESCE(${b.notes}, notes),
        site_id      = COALESCE(${b.site_id}, site_id),
        photo        = CASE WHEN ${removePhoto} THEN NULL ELSE photo END
        WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if (!requireAdminPin(req, res)) return;
      const id = parseInt((req.query && req.query.id) || (req.body && req.body.id) || '', 10);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const r = await sql`DELETE FROM qc_errors WHERE id = ${id} RETURNING id`;
      if (r.length === 0) return res.status(404).json({ error: 'Error not found' });
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
