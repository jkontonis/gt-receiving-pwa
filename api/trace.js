import { ensureSchema, sql } from './_db.js';

// Build the trace tree for a lot.
//   direction 'up'   -> ancestors  (what this lot was made FROM)  — recall a bad supplier batch
//   direction 'down' -> descendants(what was made FROM this lot)  — find affected finished product
//   direction 'both' -> { up, down } (default)

async function lotById(id) {
  const rows = await sql`SELECT * FROM lots WHERE id = ${id}`;
  return rows[0] || null;
}

// Events that PRODUCED this lot (one normally), with their input lots.
async function parentsOf(lotId) {
  const evs = await sql`
    SELECT pe.* FROM process_outputs po
    JOIN process_events pe ON pe.id = po.event_id
    WHERE po.lot_id = ${lotId}`;
  const result = [];
  for (const ev of evs) {
    const ins = await sql`
      SELECT l.*, pi.weight_kg AS used_weight_kg, pi.quantity AS used_quantity
      FROM process_inputs pi JOIN lots l ON l.id = pi.lot_id
      WHERE pi.event_id = ${ev.id}`;
    result.push({ event: ev, inputs: ins });
  }
  return result;
}

// Events that CONSUMED this lot, with their output lots.
async function childrenOf(lotId) {
  const evs = await sql`
    SELECT pe.* FROM process_inputs pi
    JOIN process_events pe ON pe.id = pi.event_id
    WHERE pi.lot_id = ${lotId}`;
  const result = [];
  for (const ev of evs) {
    const outs = await sql`
      SELECT l.* FROM process_outputs po JOIN lots l ON l.id = po.lot_id
      WHERE po.event_id = ${ev.id}`;
    result.push({ event: ev, outputs: outs });
  }
  return result;
}

async function traceUp(lotId, seen) {
  if (seen.has(lotId)) return { lot_id: lotId, cycle: true };
  seen.add(lotId);
  const lot = await lotById(lotId);
  if (!lot) return null;
  const parents = await parentsOf(lotId);
  const sources = [];
  for (const p of parents) {
    for (const inp of p.inputs) {
      sources.push({
        via: { event_id: p.event.id, event_type: p.event.event_type, process_date: p.event.process_date },
        used_weight_kg: inp.used_weight_kg,
        ...(await traceUp(inp.id, seen)),
      });
    }
  }
  return { ...lot, sources };
}

async function traceDown(lotId, seen) {
  if (seen.has(lotId)) return { lot_id: lotId, cycle: true };
  seen.add(lotId);
  const lot = await lotById(lotId);
  if (!lot) return null;
  const children = await childrenOf(lotId);
  const produced = [];
  for (const c of children) {
    for (const out of c.outputs) {
      produced.push({
        via: { event_id: c.event.id, event_type: c.event.event_type, process_date: c.event.process_date },
        ...(await traceDown(out.id, seen)),
      });
    }
  }
  return { ...lot, produced };
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Accept ?lot_id= or ?lot_code= (the human code printed on the label).
    // Lot-code match is case-insensitive + whitespace-trimmed so the operator can
    // type "gt-260601-001", "GT-260601-001", or with stray spaces and still hit.
    let lotId = Number(req.query.lot_id);
    if (!lotId && req.query.lot_code) {
      const code = String(req.query.lot_code).trim();
      const rows = await sql`SELECT id FROM lots WHERE LOWER(lot_code) = LOWER(${code})`;
      if (rows.length === 0) return res.status(404).json({ error: 'Lot code not found' });
      lotId = rows[0].id;
    }
    if (!lotId) return res.status(400).json({ error: 'Provide lot_id or lot_code' });

    const dir = String(req.query.direction || 'both');
    const out = {};
    if (dir === 'up' || dir === 'both') out.up = await traceUp(lotId, new Set());
    if (dir === 'down' || dir === 'both') out.down = await traceDown(lotId, new Set());
    return res.status(200).json(out);
  } catch (err) {
    console.error('trace error', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
