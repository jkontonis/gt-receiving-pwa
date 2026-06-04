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
      // Complaint linkage: a complaint sets lot_id / lot_code + resolution ('open'
      // by default) so the row can later be marked credited/replaced/dismissed.
      const lotId = b.lot_id ? parseInt(b.lot_id, 10) : null;
      const lotCode = b.lot_code || null;
      const resolution = b.resolution || (lotId || lotCode ? 'open' : null);
      const result = await sql`
        INSERT INTO qc_errors (occurred_at, order_number, customer, product, stage, worker_code, error_type, caught_by, action_taken, notes, client_id, photo, site_id, lot_id, lot_code, resolution)
        VALUES (${b.occurred_at}, ${b.order_number || null}, ${b.customer || null}, ${productName}, ${b.stage}, ${b.worker_code}, ${b.error_type}, ${b.caught_by || null}, ${b.action_taken || null}, ${b.notes || null}, ${b.client_id || null}, ${photo}, ${b.site_id || null}, ${lotId}, ${lotCode}, ${resolution})
        RETURNING id, created_at
      `;
      return res.status(200).json({ ok: true, id: result[0].id, created_at: result[0].created_at });
    }

    // -----------------------------------------------------------------------
    // GET: dispatch by ?action=
    // -----------------------------------------------------------------------
    if (req.method === 'GET') {
      // Lot lookup — used by the complaint flow to auto-fill worker / product /
      // supplier / customer-shipped-to / dispatch-temp from a single lot code or
      // id. Public (no PIN) because the complaint flow is staff-facing.
      if (action === 'lot_lookup') {
        const code = (req.query.code || '').trim();
        const idRaw = req.query.id ? parseInt(req.query.id, 10) : null;
        let rows;
        if (idRaw) {
          rows = await sql`SELECT id, lot_code, product, supplier, supplier_batch,
                                  kill_date, production_date, use_by, weight_kg, quantity, unit,
                                  operator AS operator_name, customer, dispatched_at, dispatch_temp_c,
                                  temp_c, status
                           FROM lots WHERE id = ${idRaw} LIMIT 1`;
        } else if (code) {
          rows = await sql`SELECT id, lot_code, product, supplier, supplier_batch,
                                  kill_date, production_date, use_by, weight_kg, quantity, unit,
                                  operator AS operator_name, customer, dispatched_at, dispatch_temp_c,
                                  temp_c, status
                           FROM lots WHERE lot_code = ${code} LIMIT 1`;
        } else {
          return res.status(400).json({ error: 'lot_lookup needs ?code= or ?id=' });
        }
        if (rows.length === 0) return res.status(200).json({ found: false });
        // Try to resolve operator_name → workers.worker_id so the iOS form can
        // pre-select the correct worker pill instead of just showing a name.
        const op = rows[0].operator_name;
        let workerCode = null;
        if (op) {
          const w = await sql`SELECT worker_id FROM workers WHERE name = ${op} OR worker_id = ${op} LIMIT 1`;
          if (w.length) workerCode = w[0].worker_id;
        }
        return res.status(200).json({ found: true, lot: rows[0], suggested_worker_code: workerCode });
      }

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
                 lot_id, lot_code, resolution,
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
                 lot_id, lot_code, resolution, resolution_note, resolved_at,
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
      // Auto-stamp resolved_at when the resolution is moved into a closed state.
      const closedStates = ['credited', 'replaced', 'dismissed', 'closed'];
      const resolvedAtSet = b.resolution && closedStates.includes(b.resolution);
      await sql`UPDATE qc_errors SET
        occurred_at     = COALESCE(${b.occurred_at}, occurred_at),
        order_number    = COALESCE(${b.order_number}, order_number),
        customer        = COALESCE(${b.customer}, customer),
        product         = COALESCE(${b.product}, product),
        stage           = COALESCE(${b.stage}, stage),
        worker_code     = COALESCE(${b.worker_code}, worker_code),
        error_type      = COALESCE(${b.error_type}, error_type),
        caught_by       = COALESCE(${b.caught_by}, caught_by),
        action_taken    = COALESCE(${b.action_taken}, action_taken),
        notes           = COALESCE(${b.notes}, notes),
        site_id         = COALESCE(${b.site_id}, site_id),
        lot_id          = COALESCE(${b.lot_id || null}, lot_id),
        lot_code        = COALESCE(${b.lot_code}, lot_code),
        resolution      = COALESCE(${b.resolution}, resolution),
        resolution_note = COALESCE(${b.resolution_note}, resolution_note),
        resolved_at     = CASE WHEN ${resolvedAtSet} THEN NOW() ELSE resolved_at END,
        photo           = CASE WHEN ${removePhoto} THEN NULL ELSE photo END
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
