import { ensureSchema, sql } from './_db.js';

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
  if (/[",]/.test(s) || /^\s|\s$/.test(s)) return '"' + s + '"';
  return s;
}

// CSV export for the weekly QC review. Mirrors qc-tracker-pwa's /api/export.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await ensureSchema();
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const rows = await sql`
      SELECT
        e.id,
        e.created_at,
        e.occurred_at,
        e.order_number,
        e.customer,
        e.product,
        e.stage,
        e.worker_code,
        COALESCE(w.name, e.worker_code) AS worker_name,
        e.error_type,
        e.caught_by,
        e.action_taken,
        e.notes,
        e.site_id,
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
        r.order_number,
        r.customer,
        r.product,
        r.stage,
        r.worker_code,
        r.worker_name,
        r.error_type,
        errorDesc[r.error_type] || r.error_type,
        r.caught_by,
        r.action_taken,
        r.notes,
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
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
