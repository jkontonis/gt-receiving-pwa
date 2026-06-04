import { ensureSchema, sql } from './_db.js';

// Single QC endpoint, multiple actions — keeps us under Vercel Hobby's
// 12-function cap. Routing by method + ?action=:
//   POST  /api/qc                    → log a new error (public, no PIN)
//   GET   /api/qc?action=data        → dashboard aggregations (public)
//   GET   /api/qc?action=export      → CSV download (public)
//   GET   /api/qc?action=list        → admin list of last 100 errors (PIN)
//   PATCH /api/qc                    → edit one error by id (PIN)
//   DELETE /api/qc?id=N              → delete one error by id (PIN)

function requireAdminPin(req, res) {
  const expected = process.env.ADMIN_PIN;
  if (!expected) { res.status(500).json({ error: 'Server misconfigured: ADMIN_PIN not set' }); return false; }
  const got = req.headers['x-admin-pin'];
  if (got !== expected) { res.status(401).json({ error: 'Unauthorized — admin PIN required' }); return false; }
  return true;
}

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
  if (/[",]/.test(s) || /^\s|\s$/.test(s)) return '"' + s + '"';
  return s;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const action = (req.query.action || (req.method === 'GET' ? 'data' : '')).toLowerCase();

    // -----------------------------------------------------------------------
    // POST: log a new error (public, no PIN). Auto-creates the product in the
    // SKU master if it isn't there.
    // -----------------------------------------------------------------------
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
      await sql`INSERT INTO products (canonical_name) VALUES (${productName})
                ON CONFLICT (canonical_name) DO NOTHING`;
      const result = await sql`
        INSERT INTO qc_errors (occurred_at, order_number, customer, product, stage, worker_code, error_type, caught_by, action_taken, notes, client_id, photo, site_id)
        VALUES (${b.occurred_at}, ${b.order_number || null}, ${b.customer || null}, ${productName}, ${b.stage}, ${b.worker_code}, ${b.error_type}, ${b.caught_by || null}, ${b.action_taken || null}, ${b.notes || null}, ${b.client_id || null}, ${photo}, ${b.site_id || null})
        RETURNING id, created_at
      `;
      return res.status(200).json({ ok: true, id: result[0].id, created_at: result[0].created_at });
    }

    // -----------------------------------------------------------------------
    // GET: dispatch by ?action=
    // -----------------------------------------------------------------------
    if (req.method === 'GET') {
      const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

      if (action === 'data') {
        const total = await sql`SELECT COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${since}`;
        const byWorker = await sql`
          SELECT e.worker_code, COALESCE(w.name, e.worker_code) AS full_name, COUNT(*)::int AS n
          FROM qc_errors e LEFT JOIN workers w ON w.worker_id = e.worker_code
          WHERE e.occurred_at >= ${since}
          GROUP BY e.worker_code, w.name
          ORDER BY n DESC`;
        const byStage = await sql`
          SELECT stage, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${since}
          GROUP BY stage ORDER BY n DESC`;
        const byType = await sql`
          SELECT error_type, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${since}
          GROUP BY error_type ORDER BY n DESC`;
        const byProduct = await sql`
          SELECT product, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${since}
          GROUP BY product ORDER BY n DESC LIMIT 10`;
        const workerStage = await sql`
          SELECT worker_code, stage, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${since}
          GROUP BY worker_code, stage`;
        const recent = await sql`
          SELECT id, created_at, occurred_at, order_number, customer, product, stage,
                 worker_code, error_type, caught_by, action_taken, notes, site_id,
                 (photo IS NOT NULL) AS has_photo
          FROM qc_errors WHERE occurred_at >= ${since}
          ORDER BY id DESC LIMIT 25`;
        return res.status(200).json({
          days, since,
          total: total[0].n,
          by_worker: byWorker,
          by_stage: byStage,
          by_type: byType,
          by_product: byProduct,
          worker_stage: workerStage,
          recent,
        });
      }

      if (action === 'list') {
        if (!requireAdminPin(req, res)) return;
        const rows = await sql`
          SELECT id, created_at, occurred_at, order_number, customer, product, stage,
                 worker_code, error_type, caught_by, action_taken, notes, site_id,
                 (photo IS NOT NULL) AS has_photo
          FROM qc_errors WHERE occurred_at >= ${since}
          ORDER BY id DESC LIMIT 100
        `;
        return res.status(200).json({ errors: rows, days });
      }

      if (action === 'export') {
        const rows = await sql`
          SELECT
            e.id, e.created_at, e.occurred_at, e.order_number, e.customer, e.product, e.stage,
            e.worker_code, COALESCE(w.name, e.worker_code) AS worker_name,
            e.error_type, e.caught_by, e.action_taken, e.notes, e.site_id,
            (e.photo IS NOT NULL) AS has_photo
          FROM qc_errors e
          LEFT JOIN workers w ON w.worker_id = e.worker_code
          WHERE e.occurred_at >= ${since}
          ORDER BY e.id DESC
        `;
        const header = [
          'ID', 'Logged at (UTC)', 'Date', 'Order #', 'Customer', 'Product', 'Stage',
          'Worker code', 'Worker name', 'Error type', 'Error description',
          'Caught by', 'Action taken', 'Notes', 'Site', 'Has photo',
        ];
        const errorDesc = { WC:'Wrong cut', WW:'Wrong weight', WQ:'Wrong qty', WP:'Wrong product', M:'Missing', O:'Other' };
        const siteName = { flemington: 'Flemington', brooklyn: 'Brooklyn' };
        const lines = [header.map(csvField).join(',')];
        for (const r of rows) {
          lines.push([
            r.id,
            r.created_at ? new Date(r.created_at).toISOString() : '',
            r.occurred_at ? new Date(r.occurred_at).toISOString().slice(0, 10) : '',
            r.order_number, r.customer, r.product, r.stage,
            r.worker_code, r.worker_name, r.error_type,
            errorDesc[r.error_type] || r.error_type,
            r.caught_by, r.action_taken, r.notes,
            siteName[r.site_id] || r.site_id || '',
            r.has_photo ? 'Y' : '',
          ].map(csvField).join(','));
        }
        const body = '﻿' + lines.join('\r\n') + '\r\n';
        const today = new Date().toISOString().slice(0, 10);
        const filename = `gtc-qc-errors-last${days}d-${today}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(body);
      }

      return res.status(400).json({ error: 'Unknown action. Use ?action=data | list | export.' });
    }

    // -----------------------------------------------------------------------
    // PATCH: edit one error by id (PIN). COALESCE means undefined leaves the
    // existing value alone. remove_photo=true nulls the photo column.
    // -----------------------------------------------------------------------
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
