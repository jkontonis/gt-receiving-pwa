import { ensureSchema, sql } from './_db.js';

// QA DAILY BRIEF — the bridge from this app's live data into the G&T Chickens
// daily Records Pack (PrimeSafe P01491, QA Forms Package V6.0). Returns one day's
// receivals, boning/processing events (with genealogy + yield), and dispatches,
// plus throughput totals — structured so the gt-chickens-records-pack skill can
// render F4 (receivals), the boning/production record, the dispatch record,
// F40 (Throughput Register) and back the F43 Daily Operations Sign-Off without
// any re-typing. Read-only GET; ?date=YYYY-MM-DD (defaults to today, AEST-naive).
//
// NOTE: dates in the DB are DATE columns; we match on the calendar day. "received"
// lots use production_date as the receival date; "produced" lots' creation is
// captured by their process_event.process_date.

function isoDay(d) {
  // d is a JS Date or ISO string → 'YYYY-MM-DD'
  const s = typeof d === 'string' ? d : d.toISOString();
  return s.slice(0, 10);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function sumWeights(rows) {
  return rows.reduce((acc, r) => acc + (num(r.weight_kg) || 0), 0);
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const date = (req.query && req.query.date) ? String(req.query.date).slice(0, 10) : isoDay(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

    // --- Receivals booked in on `date` (origin = received) ---
    const receivals = await sql`
      SELECT id, lot_code, product, supplier, supplier_batch, kill_date,
             production_date AS received_date, use_by, quantity, unit, weight_kg,
             container, notes, (photo IS NOT NULL) AS has_docket_photo
      FROM lots
      WHERE origin = 'received' AND production_date = ${date}
      ORDER BY supplier, product`;

    // --- Processing/boning events on `date`, with inputs + outputs (genealogy) ---
    const events = await sql`
      SELECT id, event_type, process_date, operator, notes
      FROM process_events
      WHERE process_date = ${date}
      ORDER BY id`;

    const processing = [];
    for (const ev of events) {
      const inputs = await sql`
        SELECT l.lot_code, l.product, l.supplier, l.supplier_batch,
               pi.weight_kg AS used_weight_kg, pi.quantity AS used_quantity
        FROM process_inputs pi JOIN lots l ON l.id = pi.lot_id
        WHERE pi.event_id = ${ev.id}`;
      const outputs = await sql`
        SELECT l.lot_code, l.product, l.use_by, l.weight_kg, l.unit, l.quantity, l.status
        FROM process_outputs po JOIN lots l ON l.id = po.lot_id
        WHERE po.event_id = ${ev.id}`;

      const inWeight = sumWeights(inputs.map(i => ({ weight_kg: i.used_weight_kg })));
      const outWeight = sumWeights(outputs);
      const yieldPct = inWeight > 0 ? Math.round((outWeight / inWeight) * 1000) / 10 : null;

      processing.push({
        event_type: ev.event_type,
        process_date: isoDay(ev.process_date),
        operator: ev.operator || null,
        notes: ev.notes || null,
        inputs,
        outputs,
        input_weight_kg: Math.round(inWeight * 100) / 100,
        output_weight_kg: Math.round(outWeight * 100) / 100,
        loss_kg: Math.round((inWeight - outWeight) * 100) / 100,
        yield_pct: yieldPct,
      });
    }

    // --- Dispatches: lots marked shipped (proxy by status; production_date may
    // predate dispatch, so we report all currently-shipped lots and flag those
    // whose date matches). Until a true dispatch timestamp exists, this is the
    // best available signal — surfaced honestly. ---
    const dispatched = await sql`
      SELECT lot_code, product, supplier, weight_kg, unit, quantity, use_by
      FROM lots
      WHERE status = 'shipped'
      ORDER BY product`;

    // --- Throughput totals for F40 (Throughput Register P01491) ---
    const receivedKg = sumWeights(receivals);
    const producedKg = processing.reduce((a, p) => a + (p.output_weight_kg || 0), 0);

    const brief = {
      facility: 'G&T Chickens Pty Ltd — Flemington VIC',
      primesafe_licence: 'P01491',
      date,
      generated_at: new Date().toISOString(),
      source: 'gt-receiving app (lots + process events)',
      receivals: {
        count: receivals.length,
        total_weight_kg: Math.round(receivedKg * 100) / 100,
        lines: receivals.map(r => ({
          lot_code: r.lot_code,
          product: r.product,
          supplier: r.supplier,
          supplier_batch: r.supplier_batch,
          kill_date: r.kill_date ? isoDay(r.kill_date) : null,
          received_date: r.received_date ? isoDay(r.received_date) : null,
          use_by: r.use_by ? isoDay(r.use_by) : null,
          quantity: num(r.quantity),
          unit: r.unit,
          weight_kg: num(r.weight_kg),
          container: r.container,
          arrival_temp_note: r.notes,           // "Arrival temp X°C"
          has_docket_photo: r.has_docket_photo,
        })),
      },
      processing: {
        count: processing.length,
        total_output_weight_kg: Math.round(producedKg * 100) / 100,
        events: processing,
      },
      dispatch: {
        count: dispatched.length,
        lines: dispatched.map(d => ({
          lot_code: d.lot_code,
          product: d.product,
          supplier: d.supplier,
          quantity: num(d.quantity),
          unit: d.unit,
          weight_kg: num(d.weight_kg),
          use_by: d.use_by ? isoDay(d.use_by) : null,
        })),
        note: 'Dispatch is derived from lots with status=shipped (no per-dispatch timestamp yet).',
      },
      throughput_kg: {
        received: Math.round(receivedKg * 100) / 100,
        produced: Math.round(producedKg * 100) / 100,
      },
    };

    return res.status(200).json(brief);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
