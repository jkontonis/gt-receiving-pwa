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
    // Operator (who did the work) is REQUIRED for audit defence.
    const operator = strOrNull(b.operator);
    if (!operator) return res.status(400).json({ error: 'An operator (worker) is required.' });
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

    // Earliest use-by across CHICKEN inputs — the hard ceiling for every fresh
    // output. INGREDIENT inputs (crumb/battermix/breadcrumb/panko) are tracked in
    // the genealogy for allergens but their shelf life must NOT cap the schnitzel:
    // the schnitzel's UBD comes from the bird lineage (fresh) or the freeze date
    // (frozen), never from the coating. So we exclude ingredient-kind lots here.
    const inputProductNames = [...new Set(inputLots.map((l) => l.product))];
    const prodRowsMeta = inputProductNames.length
      ? await sql`SELECT canonical_name, kind, category FROM products WHERE canonical_name = ANY(${inputProductNames}::text[])`
      : [];
    const kindByName = Object.fromEntries(prodRowsMeta.map((r) => [r.canonical_name, r.kind]));
    const catByName = Object.fromEntries(prodRowsMeta.map((r) => [r.canonical_name, r.category]));
    const catOf = (lot) => catByName[lot.product] || 'other';
    const chickenInputs = inputLots.filter((l) => (kindByName[l.product] || 'raw') !== 'ingredient');
    const ingredientInputs = inputLots.filter((l) => (kindByName[l.product] || 'raw') === 'ingredient');
    const inputUseBy = minDate(chickenInputs.map((l) => l.use_by));

    // ───────────────────────────────────────────────────────────────────────
    // EVENT GUARDRAILS — each event only accepts the right input category, so the
    // app's logic matches the physical process. Categories are set per product
    // (auto-classified, editable in Manage Products) — robust vs name-matching.
    // ───────────────────────────────────────────────────────────────────────
    if (eventType === 'bone_out') {
      // Bone-out (deboning) takes WHOLE BIRDS (→ breast/maryland/wings/frame) OR
      // BREAST ON BONE / barrels (→ breast fillet skin off/on only).
      const ok = chickenInputs.every((l) => catOf(l) === 'whole_bird' || catOf(l) === 'breast_on_bone');
      if (!chickenInputs.length || !ok) {
        return res.status(400).json({ error: 'Bone-out takes WHOLE BIRDS or BREAST ON BONE only. Check the input lot.' });
      }
    }
    if (eventType === 'slice') {
      // Slicing takes breast (bought-in or boned) — not whole birds, not coatings.
      const ok = chickenInputs.every((l) => catOf(l) === 'breast');
      if (!chickenInputs.length || !ok) {
        return res.status(400).json({ error: 'Slicing takes BREAST FILLET only (bought-in or boned-out).' });
      }
    }
    if (eventType === 'crumb') {
      // ONLY sliced breast can be crumbed. Plus batter + breading for the trace.
      const slicedBreast = chickenInputs.filter((l) => catOf(l) === 'sliced_breast');
      const wrongChicken = chickenInputs.filter((l) => catOf(l) !== 'sliced_breast');
      const hasBatter = ingredientInputs.some((l) => catOf(l) === 'batter' || /batter/i.test(l.product));
      const hasBreading = ingredientInputs.some((l) => catOf(l) === 'crumb' || /breadcrumb|panko|crumb/i.test(l.product));
      if (wrongChicken.length) {
        return res.status(400).json({ error: `Only SLICED BREAST FILLET can be crumbed — not ${wrongChicken[0].product}.` });
      }
      if (!slicedBreast.length || !hasBatter || !hasBreading) {
        const missing = [
          !slicedBreast.length ? 'sliced breast' : null,
          !hasBatter ? 'battermix' : null,
          !hasBreading ? 'breadcrumb/panko' : null,
        ].filter(Boolean).join(', ');
        return res.status(400).json({
          error: `A crumbed schnitzel needs all THREE parents — sliced breast + batter + breading. Missing: ${missing}.`,
        });
      }
    }

    // Variable coating: how many batter + crumb coats (default 1 each). Recorded on
    // the event so "double-battered, double-crumbed" etc. is traceable.
    const batterCoats = eventType === 'crumb' ? (Number(b.batter_coats) || 1) : null;
    const crumbCoats = eventType === 'crumb' ? (Number(b.crumb_coats) || 1) : null;

    // SUPPLIER CARRY-FORWARD: a produced lot inherits the supplier of its CHICKEN
    // input (not the coating), so a schnitzel sliced from Master Poultry breast
    // traces straight back to Master Poultry on the lot/label/sheet. If chicken
    // inputs span multiple suppliers, join them.
    const chickenSuppliers = [...new Set(chickenInputs.map((l) => l.supplier).filter(Boolean))];
    const inheritedSupplier = chickenSuppliers.length ? chickenSuppliers.join(' + ') : null;

    // Create the event.
    const evRows = await sql`
      INSERT INTO process_events (event_type, process_date, operator, notes, batter_coats, crumb_coats)
      VALUES (${eventType}, ${processDate}, ${operator}, ${strOrNull(b.notes)}, ${batterCoats}, ${crumbCoats})
      RETURNING *`;
    const event = evRows[0];

    // Record inputs and update their status / remaining weight.
    for (const inp of inputs) {
      const lotId = Number(inp.lot_id);
      const usedKg  = numOrNull(inp.weight_kg);
      const usedQty = numOrNull(inp.quantity);
      await sql`
        INSERT INTO process_inputs (event_id, lot_id, weight_kg, quantity)
        VALUES (${event.id}, ${lotId}, ${usedKg}, ${usedQty})`;

      if (inp.keep_open) {
        // PARTIAL consumption (or ingredient that spans runs) — decrement the
        // lot's remaining weight/qty by what this run actually used, leaving
        // the rest available. If the decrement empties the lot (epsilon ≤ 10g
        // or 0.01 unit), auto-mark it consumed so it stops showing as WIP.
        if (usedKg != null) {
          await sql`UPDATE lots
                    SET weight_kg = GREATEST(COALESCE(weight_kg, 0) - ${usedKg}, 0)
                    WHERE id = ${lotId}`;
          await sql`UPDATE lots SET status = 'consumed'
                    WHERE id = ${lotId} AND COALESCE(weight_kg, 0) <= 0.01 AND status != 'consumed'`;
        }
        if (usedQty != null) {
          await sql`UPDATE lots
                    SET quantity = GREATEST(COALESCE(quantity, 0) - ${usedQty}, 0)
                    WHERE id = ${lotId}`;
          await sql`UPDATE lots SET status = 'consumed'
                    WHERE id = ${lotId} AND COALESCE(quantity, 0) <= 0.01 AND status != 'consumed'`;
        }
        // If neither was supplied (e.g. an ingredient row with no measured kg),
        // the lot is intentionally left fully intact — caller chose keep_open
        // without telling us how much was used.
      } else {
        // FULL consumption (default).
        await sql`UPDATE lots SET status = 'consumed' WHERE id = ${lotId}`;
      }
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
      // UBD rule:
      //   FRESH  → min(shelf-life cap, earliest input UBD)  — can't outlive the bird.
      //   FROZEN → shelf-life cap only — freezing arrests spoilage, so the frozen
      //            product legitimately outlives the fresh source UBD (no cap).
      // A product is treated as frozen if the output is flagged frozen OR its name
      // contains "frozen".
      const isFrozen = out.frozen === true
        || /frozen/i.test(product);
      const useBy = isFrozen
        ? isoDate(shelfDate)
        : isoDate(minDate([shelfDate, inputUseBy]));

      const insLot = await sql`
        INSERT INTO lots
          (lot_code, product, origin, status, production_date, use_by,
           quantity, unit, weight_kg, container, notes, operator, site, supplier)
        VALUES
          ('PENDING', ${product}, 'produced', 'available', ${processDate}, ${useBy},
           ${numOrNull(out.quantity)}, ${strOrNull(out.unit)}, ${numOrNull(out.weight_kg)},
           ${strOrNull(out.container)}, ${strOrNull(out.notes)}, ${operator}, ${strOrNull(b.site)},
           ${inheritedSupplier})
        RETURNING *`;
      const lot = insLot[0];
      const code = strOrNull(out.lot_code) || lotCodeFor(processDate, lot.id);
      const upd = await sql`UPDATE lots SET lot_code = ${code} WHERE id = ${lot.id} RETURNING *`;
      const finalLot = upd[0];

      await sql`INSERT INTO process_outputs (event_id, lot_id) VALUES (${event.id}, ${finalLot.id})`;
      producedLots.push(finalLot);
    }

    // Auto-capture bone/trim/loss = chicken input kg − produced output kg. Only
    // weighed kg count (piece-count "each" outputs and ingredient inputs excluded).
    const inputKg = chickenInputs.reduce((a, l) => a + (Number(l.weight_kg) || 0), 0);
    const outputKg = producedLots.reduce((a, l) => a + (Number(l.weight_kg) || 0), 0);
    const lossKg = inputKg > 0 ? Math.round((inputKg - outputKg) * 100) / 100 : null;
    if (lossKg !== null) {
      await sql`UPDATE process_events SET loss_kg = ${lossKg} WHERE id = ${event.id}`;
      event.loss_kg = lossKg;
    }

    return res.status(201).json({
      event,
      inputs: inputLots.map((l) => ({ id: l.id, lot_code: l.lot_code, product: l.product })),
      outputs: producedLots,
      loss_kg: lossKg,
    });
  } catch (err) {
    console.error('process error', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
