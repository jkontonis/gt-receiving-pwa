import { ensureSchema, sql, lotCodeFor, minDate, isoDate } from './_db.js';

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
    // POST — record a process event (bone-out / portion / slice / crumb).
    // Consumes one or more input lots and produces one or more output lots.
    // The input->output link is the genealogy edge.
    //
    // Body:
    //   event_type   'bone_out' | 'portion' | 'slice' | 'crumb' | ...
    //   process_date 'YYYY-MM-DD' (defaults to today)
    //   operator, notes
    //   inputs:  [{ lot_id, weight_kg?, quantity?, keep_open? }]
    //   outputs: [{ product, weight_kg?, quantity?, unit?, container?, lot_code? }]
    //
    // UBD rule: each output's use-by = min(earliest input UBD,
    //           process_date + product.shelf_life_days [default 7]).
    // Processed product can never outlive its source.
    // -----------------------------------------------------------------------
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const b = req.body || {};
    const eventType = strOrNull(b.event_type);
    if (!eventType) return res.status(400).json({ error: 'Missing required field: event_type' });
    const processDate = strOrNull(b.process_date) || new Date().toISOString().slice(0, 10);
    const inputs = Array.isArray(b.inputs) ? b.inputs : [];
    const outputs = Array.isArray(b.outputs) ? b.outputs : [];
    if (inputs.length === 0) return res.status(400).json({ error: 'At least one input lot is required.' });
    if (outputs.length === 0) return res.status(400).json({ error: 'At least one output product is required.' });

    // Load the input lots and validate they exist + aren't already consumed.
    const inputIds = inputs.map((i) => Number(i.lot_id)).filter(Boolean);
    if (inputIds.length !== inputs.length) {
      return res.status(400).json({ error: 'Every input needs a valid lot_id.' });
    }
    const inputLots = await sql`SELECT * FROM lots WHERE id = ANY(${inputIds}::int[])`;
    if (inputLots.length !== inputIds.length) {
      return res.status(400).json({ error: 'One or more input lots were not found.' });
    }
    const consumed = inputLots.filter((l) => l.status === 'consumed');
    if (consumed.length) {
      return res.status(409).json({
        error: `These lots are already fully consumed: ${consumed.map((l) => l.lot_code).join(', ')}`,
      });
    }

    // Earliest use-by across all inputs — the hard ceiling for every output.
    const inputUseBy = minDate(inputLots.map((l) => l.use_by));

    // Create the event.
    const evRows = await sql`
      INSERT INTO process_events (event_type, process_date, operator, notes)
      VALUES (${eventType}, ${processDate}, ${strOrNull(b.operator)}, ${strOrNull(b.notes)})
      RETURNING *`;
    const event = evRows[0];

    // Record inputs and update their status.
    for (const inp of inputs) {
      const lotId = Number(inp.lot_id);
      await sql`
        INSERT INTO process_inputs (event_id, lot_id, weight_kg, quantity)
        VALUES (${event.id}, ${lotId}, ${numOrNull(inp.weight_kg)}, ${numOrNull(inp.quantity)})`;
      // Default: the input is fully consumed by this process. Pass keep_open:true
      // (e.g. taking only part of a bin) to leave it available for further use.
      const newStatus = inp.keep_open ? 'available' : 'consumed';
      await sql`UPDATE lots SET status = ${newStatus} WHERE id = ${lotId}`;
    }

    // Create the output lots, each with a carried-down UBD.
    const producedLots = [];
    for (const out of outputs) {
      const product = strOrNull(out.product);
      if (!product) {
        return res.status(400).json({ error: 'Each output needs a product.' });
      }
      // Look up (or create) the product to get its shelf life.
      let prodRows = await sql`SELECT shelf_life_days FROM products WHERE canonical_name = ${product}`;
      if (prodRows.length === 0) {
        await sql`INSERT INTO products (canonical_name, unit, kind, shelf_life_days)
                  VALUES (${product}, ${strOrNull(out.unit)}, 'processed', 7)
                  ON CONFLICT (canonical_name) DO NOTHING`;
        prodRows = await sql`SELECT shelf_life_days FROM products WHERE canonical_name = ${product}`;
      }
      const shelfLife = prodRows.length ? Number(prodRows[0].shelf_life_days) || 7 : 7;

      // process_date + shelf_life_days
      const shelfDate = new Date(processDate);
      shelfDate.setUTCDate(shelfDate.getUTCDate() + shelfLife);
      // UBD = the earlier of (shelf-life cap) and (earliest input UBD).
      const useBy = isoDate(minDate([shelfDate, inputUseBy]));

      const insLot = await sql`
        INSERT INTO lots
          (lot_code, product, origin, status, production_date, use_by,
           quantity, unit, weight_kg, container, notes)
        VALUES
          ('PENDING', ${product}, 'produced', 'available', ${processDate}, ${useBy},
           ${numOrNull(out.quantity)}, ${strOrNull(out.unit)}, ${numOrNull(out.weight_kg)},
           ${strOrNull(out.container)}, ${strOrNull(out.notes)})
        RETURNING *`;
      const lot = insLot[0];
      const code = strOrNull(out.lot_code) || lotCodeFor(processDate, lot.id);
      const upd = await sql`UPDATE lots SET lot_code = ${code} WHERE id = ${lot.id} RETURNING *`;
      const finalLot = upd[0];

      await sql`INSERT INTO process_outputs (event_id, lot_id) VALUES (${event.id}, ${finalLot.id})`;
      producedLots.push(finalLot);
    }

    return res.status(201).json({
      event,
      inputs: inputLots.map((l) => ({ id: l.id, lot_code: l.lot_code, product: l.product })),
      outputs: producedLots,
    });
  } catch (err) {
    console.error('process error', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
