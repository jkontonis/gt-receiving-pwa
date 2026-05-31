import { ensureSchema, sql } from './_db.js';

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
  if (/[",]/.test(s) || /^\s|\s$/.test(s)) return '"' + s + '"';
  return s;
}

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
      SELECT id, created_at, received_on, received_ts, barcode, product, supplier,
             quantity, unit, weight_kg, batch_number, use_by, notes,
             (photo IS NOT NULL) AS has_photo
      FROM receipts
      WHERE received_on >= ${since}
      ORDER BY id DESC`;

    const header = [
      'ID', 'Logged at (UTC)', 'Received on', 'Barcode', 'Product', 'Supplier',
      'Quantity', 'Unit', 'Weight (kg)', 'Batch #', 'Use-by', 'Notes', 'Has photo',
    ];
    const lines = [header.map(csvField).join(',')];
    for (const r of rows) {
      lines.push([
        r.id,
        r.created_at ? new Date(r.created_at).toISOString() : '',
        r.received_on ? new Date(r.received_on).toISOString().slice(0, 10) : '',
        r.barcode,
        r.product,
        r.supplier,
        r.quantity,
        r.unit,
        r.weight_kg,
        r.batch_number,
        r.use_by ? new Date(r.use_by).toISOString().slice(0, 10) : '',
        r.notes,
        r.has_photo ? 'Y' : '',
      ].map(csvField).join(','));
    }

    const body = '﻿' + lines.join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    const filename = `gtc-receiving-last${days}d-${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(body);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
