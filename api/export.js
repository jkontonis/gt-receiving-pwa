import { ensureSchema, sql } from './_db.js';

// Spreadsheet export of the LOTS + GENEALOGY model (the receipts table is legacy).
//   ?dataset=lots   → one row per lot (received + produced)            [default]
//   ?dataset=events → one row per process output, with its input lots  (genealogy)
//   ?format=csv     → downloadable CSV (default)
//   ?format=json    → JSON array (consumed by the Google Sheet sync)
//   ?days=N         → window on created_at (default 3650 = ~all)
//
// Read-only GET. The DB is the system of record; this just surfaces it as a sheet.

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
  if (/[",]/.test(s) || /^\s|\s$/.test(s)) return '"' + s + '"';
  return s;
}

function toCSV(header, rows) {
  const lines = [header.map(csvField).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function isoDay(d) { return d ? new Date(d).toISOString().slice(0, 10) : ''; }
function isoTs(d)  { return d ? new Date(d).toISOString() : ''; }

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await ensureSchema();
    const dataset = String(req.query.dataset || 'lots').toLowerCase();
    const format = String(req.query.format || 'csv').toLowerCase();
    const days = Math.min(Math.max(parseInt(req.query.days || '3650', 10) || 3650, 1), 3650);
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    let header, objects, rows, name;

    if (dataset === 'events') {
      // One row per produced output, carrying the event + its input genealogy.
      const evs = await sql`
        SELECT pe.id AS event_id, pe.event_type, pe.process_date, pe.operator, pe.notes,
               ol.lot_code AS output_lot, ol.product AS output_product,
               ol.weight_kg AS output_weight_kg, ol.quantity AS output_qty,
               ol.unit AS output_unit, ol.use_by AS output_use_by, ol.status AS output_status
        FROM process_events pe
        JOIN process_outputs po ON po.event_id = pe.id
        JOIN lots ol ON ol.id = po.lot_id
        WHERE pe.created_at >= ${since}
        ORDER BY pe.id DESC, ol.lot_code`;

      // Inputs per event (concatenated for the genealogy column).
      const inputsByEvent = {};
      const ins = await sql`
        SELECT pi.event_id, il.lot_code, il.product
        FROM process_inputs pi JOIN lots il ON il.id = pi.lot_id
        WHERE pi.event_id IN (SELECT id FROM process_events WHERE created_at >= ${since})`;
      for (const r of ins) {
        (inputsByEvent[r.event_id] ||= []).push(`${r.lot_code} (${r.product})`);
      }

      objects = evs.map((e) => ({
        event_id: e.event_id,
        event_type: e.event_type,
        process_date: isoDay(e.process_date),
        operator: e.operator || '',
        made_from: (inputsByEvent[e.event_id] || []).join(' + '),
        output_lot: e.output_lot,
        output_product: e.output_product,
        output_weight_kg: e.output_weight_kg,
        output_qty: e.output_qty,
        output_unit: e.output_unit,
        output_use_by: isoDay(e.output_use_by),
        output_status: e.output_status,
        notes: e.notes || '',
      }));
      header = ['Event ID', 'Process', 'Date', 'Operator', 'Made from (inputs)',
        'Output lot', 'Output product', 'Output kg', 'Output qty', 'Unit',
        'Use-by', 'Status', 'Notes'];
      rows = objects.map((o) => [o.event_id, o.event_type, o.process_date, o.operator,
        o.made_from, o.output_lot, o.output_product, o.output_weight_kg, o.output_qty,
        o.output_unit, o.output_use_by, o.output_status, o.notes]);
      name = 'lots-events';
    } else {
      // Every lot — received and produced.
      const lots = await sql`
        SELECT id, lot_code, product, origin, status, supplier, supplier_batch,
               kill_date, production_date, use_by, quantity, unit, weight_kg,
               container, notes, created_at, (photo IS NOT NULL) AS has_photo
        FROM lots
        WHERE created_at >= ${since}
        ORDER BY id DESC`;
      objects = lots.map((l) => ({
        lot_code: l.lot_code,
        product: l.product,
        origin: l.origin,
        status: l.status,
        supplier: l.supplier || '',
        supplier_batch: l.supplier_batch || '',
        kill_date: isoDay(l.kill_date),
        production_date: isoDay(l.production_date),
        use_by: isoDay(l.use_by),
        quantity: l.quantity,
        unit: l.unit || '',
        weight_kg: l.weight_kg,
        container: l.container || '',
        notes: l.notes || '',
        has_photo: l.has_photo ? 'Y' : '',
        logged_at: isoTs(l.created_at),
      }));
      header = ['Lot code', 'Product', 'Origin', 'Status', 'Supplier', 'Supplier batch',
        'Kill date', 'Production date', 'Use-by', 'Quantity', 'Unit', 'Weight (kg)',
        'Container', 'Notes', 'Photo', 'Logged at (UTC)'];
      rows = objects.map((o) => [o.lot_code, o.product, o.origin, o.status, o.supplier,
        o.supplier_batch, o.kill_date, o.production_date, o.use_by, o.quantity, o.unit,
        o.weight_kg, o.container, o.notes, o.has_photo, o.logged_at]);
      name = 'lots';
    }

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ dataset, header, rows: objects });
    }

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="gtc-${name}-${today}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(toCSV(header, rows));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
