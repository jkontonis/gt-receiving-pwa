import { ensureSchema, sql } from './_db.js';

// Dashboard aggregations for the QC error log. Mirrors qc-tracker-pwa's
// /api/data shape so the existing PWA front-end can repoint here unchanged.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await ensureSchema();
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().slice(0, 10);

    const total = await sql`SELECT COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${sinceStr}`;
    const byWorker = await sql`
      SELECT e.worker_code, COALESCE(w.name, e.worker_code) AS full_name, COUNT(*)::int AS n
      FROM qc_errors e LEFT JOIN workers w ON w.worker_id = e.worker_code
      WHERE e.occurred_at >= ${sinceStr}
      GROUP BY e.worker_code, w.name
      ORDER BY n DESC`;
    const byStage = await sql`
      SELECT stage, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${sinceStr}
      GROUP BY stage ORDER BY n DESC`;
    const byType = await sql`
      SELECT error_type, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${sinceStr}
      GROUP BY error_type ORDER BY n DESC`;
    const byProduct = await sql`
      SELECT product, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${sinceStr}
      GROUP BY product ORDER BY n DESC LIMIT 10`;
    const workerStage = await sql`
      SELECT worker_code, stage, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${sinceStr}
      GROUP BY worker_code, stage`;
    const recent = await sql`
      SELECT id, created_at, occurred_at, product, stage, worker_code, error_type, caught_by, notes,
             (photo IS NOT NULL) AS has_photo
      FROM qc_errors WHERE occurred_at >= ${sinceStr}
      ORDER BY id DESC LIMIT 25`;

    return res.status(200).json({
      days, since: sinceStr,
      total: total[0].n,
      by_worker: byWorker,
      by_stage: byStage,
      by_type: byType,
      by_product: byProduct,
      worker_stage: workerStage,
      recent,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
