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

// --- Records-Pack brief rendering (?format=brief) -------------------------
// Turns the JSON brief into the exact text template the gt-chickens-records-pack
// skill consumes (RECEIVALS / PRODUCTION / DISPATCHES / PERSONNEL / MAINTENANCE /
// NCs / CARRY-OVER). App-known fields are pre-filled; office-only fields the app
// can't know are emitted as [FILL …] so John completes them in one pass.

// Approved-supplier codes per the skill's master register. Only suppliers with an
// allocated code are mapped; others print by name (the skill activates codes later).
const SUPPLIER_CODES = {
  inghams: 'S-02',
  "hazeldene's": 'S-06',
  hazeldenes: 'S-06',
  hazeldene: 'S-06',
};

function supplierWithCode(name) {
  if (!name) return '[FILL: supplier]';
  const code = SUPPLIER_CODES[String(name).trim().toLowerCase()];
  return code ? `${name} (${code})` : name;
}

function ddmmyyyy(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function weekday(iso) {
  // iso = 'YYYY-MM-DD' → 'Mon'..'Sun' (parse as local midnight, no TZ drift)
  const dt = new Date(`${iso}T00:00:00`);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()];
}

function hhmm(iso) {
  // ISO timestamp → 'HH:MM' in Melbourne time (AEST UTC+10; the site is Flemington VIC)
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString('en-AU', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Australia/Melbourne',
    });
  } catch {
    return iso.slice(11, 16);
  }
}

function probeFromNote(note) {
  if (!note) return null;
  const m = String(note).match(/(-?\d+(?:\.\d+)?)\s*°?C/i);
  return m ? `probe ${m[1]}°C` : null;
}

function qtyStr(weightKg, quantity, unit) {
  if (weightKg != null) return `${weightKg} kg`;
  if (quantity != null) {
    const u = unit || 'unit';
    const plural = quantity !== 1 && !/s$/.test(u) ? `${u}s` : u;
    return `${quantity} ${plural}`;
  }
  return '[FILL: qty]';
}

function renderBrief(brief) {
  const L = [];
  L.push(`Day [N] — ${weekday(brief.date)} ${ddmmyyyy(brief.date)}`);
  L.push('');
  L.push('# Pre-filled from the receiving app (lots + process events).');
  L.push('# [FILL …] = office-only fields the app does not capture — complete before building the pack.');
  L.push('');

  // RECEIVALS
  L.push('RECEIVALS:');
  if (!brief.receivals.lines.length) {
    L.push('- NIL');
  } else {
    for (const r of brief.receivals.lines) {
      const detail = [];
      if (r.supplier_batch) detail.push(`supplier lot ${r.supplier_batch}`);
      if (r.use_by) detail.push(`UBD ${ddmmyyyy(r.use_by)}`);
      if (r.kill_date) detail.push(`kill ${ddmmyyyy(r.kill_date)}`);
      const detailStr = detail.length ? ` (${detail.join(', ')})` : '';
      const probe = probeFromNote(r.arrival_temp_note) || '[FILL: probe °C]';
      const docket = r.has_docket_photo ? ' [docket photo on file]' : '';
      L.push(
        `- ${supplierWithCode(r.supplier)}, Inv [FILL: invoice/del #], ` +
        `${qtyStr(r.weight_kg, r.quantity, r.unit)} "${r.product}"${detailStr}, ` +
        `${probe}${docket}`
      );
    }
  }
  L.push('');

  // PRODUCTION / BONING
  L.push('PRODUCTION / BONING:');
  if (!brief.processing.events.length) {
    L.push('- NIL');
  } else {
    for (const ev of brief.processing.events) {
      const ins = ev.inputs.map(i => `${i.product} [${i.lot_code}]`).join(' + ') || '[inputs]';
      const outs = ev.outputs
        .map(o => `${o.product} ${qtyStr(num(o.weight_kg), num(o.quantity), o.unit)} [${o.lot_code}]`)
        .join(', ') || '[outputs]';
      const yieldStr = ev.yield_pct != null ? `, yield ${ev.yield_pct}%` : '';
      const op = ev.operator ? `, operator ${ev.operator}` : '';
      L.push(
        `- ${String(ev.event_type).toUpperCase()} (${ddmmyyyy(ev.process_date)}): ${ins} → ${outs}` +
        ` [in ${ev.input_weight_kg} kg → out ${ev.output_weight_kg} kg${yieldStr}]${op}`
      );
      if (ev.notes) L.push(`  note: ${ev.notes}`);
    }
  }
  L.push('');

  // DISPATCHES
  L.push('DISPATCHES:');
  if (!brief.dispatch.lines.length) {
    L.push('- NIL');
  } else {
    for (const d of brief.dispatch.lines) {
      const time = hhmm(d.dispatched_at) || '[FILL: time]';
      const dest = d.customer || 'Brooklyn (P00675)';
      const probe = d.dispatch_temp_c != null ? `probe ${d.dispatch_temp_c}°C` : '[FILL: probe °C]';
      L.push(
        `- ${time}, ${qtyStr(d.weight_kg, d.quantity, d.unit)} "${d.product}" [${d.lot_code}]` +
        ` → ${dest}, ${probe}`
      );
    }
  }
  if (brief.dispatch.undated_shipped_count) {
    L.push(`# NB: ${brief.dispatch.undated_shipped_count} shipped lot(s) have no dispatch date — not shown above.`);
  }
  L.push('');

  // Office-only sections the app can't source
  L.push('PERSONNEL ON SITE:');
  L.push('- [FILL: boning crew / inductions / visitors — or NIL]');
  L.push('');
  L.push('MAINTENANCE / VISITS:');
  L.push('- [FILL: WO# / contractor / scope / outcome — or NIL]');
  L.push('');
  L.push('NCs / HOLDS / COMPLAINTS:');
  L.push('- [FILL: NC# / batch / issue / action — or NIL]');
  L.push('');
  L.push('CARRY-OVER CHANGES:');
  L.push('- [FILL: items closed/opened today; PSL-005/006 default OPEN]');
  L.push('');

  // Throughput footer (backs F40 Throughput Register P01491)
  L.push(
    `THROUGHPUT (F40): received ${brief.throughput_kg.received} kg, ` +
    `produced ${brief.throughput_kg.produced} kg.`
  );

  return L.join('\n');
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

    // --- Dispatches shipped ON `date` (real per-dispatch timestamp + customer).
    // A lot becomes shipped via lots.js PATCH, which stamps dispatched_at. Legacy
    // shipped lots with a null dispatched_at can't be placed on a day, so they're
    // excluded here (surfaced separately as a count for honesty). ---
    const dispatched = await sql`
      SELECT lot_code, product, supplier, weight_kg, unit, quantity, use_by,
             dispatched_at, customer, dispatch_temp_c
      FROM lots
      WHERE status = 'shipped' AND dispatched_at::date = ${date}
      ORDER BY dispatched_at`;
    const undatedShipped = await sql`
      SELECT COUNT(*)::int AS n FROM lots
      WHERE status = 'shipped' AND dispatched_at IS NULL`;

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
          dispatched_at: d.dispatched_at ? new Date(d.dispatched_at).toISOString() : null,
          customer: d.customer || null,
          dispatch_temp_c: num(d.dispatch_temp_c),
        })),
        undated_shipped_count: undatedShipped[0] ? undatedShipped[0].n : 0,
        note: 'Dispatches shipped on this date (lots.js stamps dispatched_at when status→shipped).',
      },
      throughput_kg: {
        received: Math.round(receivedKg * 100) / 100,
        produced: Math.round(producedKg * 100) / 100,
      },
    };

    const format = req.query && req.query.format ? String(req.query.format).toLowerCase() : 'json';
    if (format === 'brief' || format === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(renderBrief(brief));
    }

    return res.status(200).json(brief);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
