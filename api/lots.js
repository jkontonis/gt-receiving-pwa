import { ensureSchema, sql, lotCodeFor } from './_db.js';

function requireAdminPin(req, res) {
  const expected = process.env.ADMIN_PIN;
  if (!expected) { res.status(500).json({ error: 'Server misconfigured: ADMIN_PIN not set' }); return false; }
  const got = req.headers['x-admin-pin'];
  if (got !== expected) { res.status(401).json({ error: 'Unauthorized — admin PIN required' }); return false; }
  return true;
}

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

// NOTE on returned columns: list/single responses deliberately SELECT explicit
// columns and EXCLUDE the (large, base64) photo so payloads stay light — a
// has_photo flag is enough; the image is fetched on demand via /api/photo?lot=ID.

export default async function handler(req, res) {
  try {
    await ensureSchema();

    // -----------------------------------------------------------------------
    // POST — create a RECEIVED lot (incoming WIP from a supplier delivery).
    // Staff-facing, no admin PIN. Captures the supplier kill date + UBD so they
    // can be carried down when the lot is later boned out.
    // -----------------------------------------------------------------------
    if (req.method === 'POST') {
      const b = req.body || {};
      const product = strOrNull(b.product);
      if (!product) return res.status(400).json({ error: 'Missing required field: product' });

      const productionDate = strOrNull(b.production_date) || strOrNull(b.received_on)
        || new Date().toISOString().slice(0, 10);
      const qty = numOrNull(b.quantity);
      const weight = numOrNull(b.weight_kg);
      if (qty === null && weight === null) {
        return res.status(400).json({ error: 'Enter a quantity or a weight.' });
      }

      let photo = strOrNull(b.photo);
      if (photo && photo.length > 600 * 1024) {
        return res.status(413).json({ error: 'Photo too large — please retake.' });
      }

      // Offline replay de-dupe: if this client_id already booked a lot, return it
      // unchanged rather than creating a duplicate (the app retries queued lots).
      const clientId = strOrNull(b.client_id);
      if (clientId) {
        const dup = await sql`
          SELECT id, lot_code, product, origin, status, supplier, supplier_batch,
                 kill_date, production_date, use_by, quantity, unit, weight_kg,
                 container, receipt_id, notes, created_at, (photo IS NOT NULL) AS has_photo
          FROM lots WHERE client_id = ${clientId}`;
        if (dup.length > 0) return res.status(200).json({ lot: dup[0], duplicate: true });
      }

      // Make sure the product exists (so later processing knows its shelf life).
      await sql`INSERT INTO products (canonical_name, unit, kind)
                VALUES (${product}, ${strOrNull(b.unit)}, 'raw')
                ON CONFLICT (canonical_name) DO NOTHING`;

      // GTIN / barcode learning. The app looks products up by GTIN (falling back
      // to the raw scanned code), so learn the mapping under that same key, and
      // stamp the product's gtin column so the *cached* product list can match
      // offline next time (no network round-trip needed).
      const gtin = strOrNull(b.gtin);
      const rawBarcode = strOrNull(b.barcode);
      const lookupKey = gtin || rawBarcode;
      if (lookupKey) {
        await sql`INSERT INTO product_barcodes (barcode, product, supplier, unit)
                  VALUES (${lookupKey}, ${product}, ${strOrNull(b.supplier)}, ${strOrNull(b.unit)})
                  ON CONFLICT (barcode) DO UPDATE SET
                    product = EXCLUDED.product,
                    supplier = COALESCE(EXCLUDED.supplier, product_barcodes.supplier),
                    unit = COALESCE(EXCLUDED.unit, product_barcodes.unit)`;
      }
      if (gtin) {
        await sql`UPDATE products SET gtin = ${gtin}
                  WHERE canonical_name = ${product} AND (gtin IS NULL OR gtin = '')`;
      }

      const status = strOrNull(b.status) || 'available';
      // Cold-chain: arrival temp as data + out-of-spec flag (chilled ≤ 4 °C).
      const tempC = numOrNull(b.temp_c);
      const tempOk = tempC === null ? null : (tempC <= 4);
      const inserted = await sql`
        INSERT INTO lots
          (lot_code, product, origin, status, supplier, supplier_batch,
           kill_date, production_date, use_by, quantity, unit, weight_kg,
           container, receipt_id, notes, photo, client_id, temp_c, temp_ok, operator, site)
        VALUES
          ('PENDING', ${product}, 'received', ${status}, ${strOrNull(b.supplier)},
           ${strOrNull(b.supplier_batch)}, ${strOrNull(b.kill_date)}, ${productionDate},
           ${strOrNull(b.use_by)}, ${qty}, ${strOrNull(b.unit)}, ${weight},
           ${strOrNull(b.container)}, ${numOrNull(b.receipt_id)}, ${strOrNull(b.notes)},
           ${photo}, ${clientId}, ${tempC}, ${tempOk}, ${strOrNull(b.operator)}, ${strOrNull(b.site)})
        RETURNING id`;
      const newId = inserted[0].id;
      const code = strOrNull(b.lot_code) || lotCodeFor(productionDate, newId);
      const updated = await sql`
        UPDATE lots SET lot_code = ${code} WHERE id = ${newId}
        RETURNING id, lot_code, product, origin, status, supplier, supplier_batch,
                  kill_date, production_date, use_by, quantity, unit, weight_kg,
                  container, receipt_id, notes, created_at, temp_c, temp_ok, operator, site,
                  (photo IS NOT NULL) AS has_photo`;
      return res.status(201).json({ lot: updated[0] });
    }

    // -----------------------------------------------------------------------
    // GET — list lots (?status= ?product= ?origin= ?q= ?days=) or one (?id=).
    // -----------------------------------------------------------------------
    if (req.method === 'GET') {
      const { id, status, product, origin, q, days, dispatches_for } = req.query;

      // Per-lot dispatch history — used by the iOS lot detail screen so each
      // partial ship to each customer stays visible (no overwrites).
      if (dispatches_for) {
        const lid = Number(dispatches_for);
        if (!lid) return res.status(400).json({ error: 'Missing lot id' });
        const rows = await sql`
          SELECT id, lot_id, dispatched_at, quantity, weight_kg, unit,
                 customer, dispatch_temp_c, operator, notes
          FROM dispatches WHERE lot_id = ${lid}
          ORDER BY dispatched_at DESC, id DESC`;
        return res.status(200).json({ dispatches: rows });
      }

      if (id) {
        const rows = await sql`
          SELECT id, lot_code, product, origin, status, supplier, supplier_batch,
                 kill_date, production_date, use_by, quantity, unit, weight_kg,
                 container, receipt_id, notes, created_at, temp_c, temp_ok, operator, site,
                 (photo IS NOT NULL) AS has_photo
          FROM lots WHERE id = ${Number(id)}`;
        if (rows.length === 0) return res.status(404).json({ error: 'Lot not found' });
        return res.status(200).json({ lot: rows[0] });
      }

      const d = Math.min(Math.max(parseInt(days || '90', 10) || 90, 1), 3650);
      const since = new Date(Date.now() - d * 86400000).toISOString();
      const like = q ? `%${String(q)}%` : null;
      const st = status || null;
      const pr = product || null;
      const og = origin || null;
      const rows = await sql`
        SELECT id, lot_code, product, origin, status, supplier, supplier_batch,
               kill_date, production_date, use_by, quantity, unit, weight_kg,
               container, receipt_id, notes, created_at, temp_c, temp_ok, operator, site,
               (photo IS NOT NULL) AS has_photo
        FROM lots
        WHERE created_at >= ${since}
          AND (${st}::text IS NULL OR status = ${st})
          AND (${pr}::text IS NULL OR product = ${pr})
          AND (${og}::text IS NULL OR origin = ${og})
          AND (${like}::text IS NULL OR lot_code ILIKE ${like}
               OR product ILIKE ${like} OR COALESCE(supplier,'') ILIKE ${like}
               OR COALESCE(supplier_batch,'') ILIKE ${like})
        ORDER BY created_at DESC
        LIMIT 500`;
      return res.status(200).json({ lots: rows });
    }

    // -----------------------------------------------------------------------
    // PATCH / DELETE — admin-gated corrections.
    // -----------------------------------------------------------------------
    if (req.method === 'PATCH') {
      if (!requireAdminPin(req, res)) return;
      const b = req.body || {};
      const id = Number(b.id);
      if (!id) return res.status(400).json({ error: 'Missing id' });

      // DISPATCH (partial or full) path: caller sent dispatch_qty / dispatch_kg
      // and/or status='shipped'. Either way we want to log ONE row in the
      // `dispatches` audit table per event, so multiple partial shipments to
      // different customers don't overwrite each other.
      const dispatchQty = b.dispatch_qty != null ? Number(b.dispatch_qty) : null;
      const dispatchKg  = b.dispatch_kg  != null ? Number(b.dispatch_kg)  : null;
      const dispatchTemp = b.dispatch_temp_c != null ? Number(b.dispatch_temp_c) : null;
      const customer = b.customer || null;
      const operatorName = b.operator || null;

      if (dispatchQty != null || dispatchKg != null) {
        const cur = await sql`SELECT id, quantity, weight_kg, status, unit FROM lots WHERE id = ${id}`;
        if (cur.length === 0) return res.status(404).json({ error: 'Lot not found' });
        const onHandQty = Number(cur[0].quantity || 0);
        const onHandKg  = Number(cur[0].weight_kg || 0);
        const lotUnit   = cur[0].unit;
        const partial =
          (dispatchQty != null && dispatchQty > 0 && dispatchQty < onHandQty - 0.0001) ||
          (dispatchKg  != null && dispatchKg  > 0 && dispatchKg  < onHandKg  - 0.0001);
        if (partial) {
          // Record this specific dispatch event (the audit trail).
          await sql`INSERT INTO dispatches
            (lot_id, quantity, weight_kg, unit, customer, dispatch_temp_c, operator, notes, client_id)
            VALUES (${id}, ${dispatchQty}, ${dispatchKg}, ${lotUnit}, ${customer},
                    ${dispatchTemp}, ${operatorName}, ${b.notes || null}, ${b.client_id || null})`;
          // Decrement remaining qty/weight, keep status available. Do NOT touch
          // lot.customer / lot.dispatched_at — those would otherwise mislead the
          // dashboard into showing the latest partial customer as "the" customer.
          // The dispatches table is the source of truth for who got what when.
          await sql`UPDATE lots SET
            quantity  = CASE WHEN ${dispatchQty != null}::bool THEN GREATEST(COALESCE(quantity,0) - ${dispatchQty}, 0) ELSE quantity END,
            weight_kg = CASE WHEN ${dispatchKg  != null}::bool THEN GREATEST(COALESCE(weight_kg,0) - ${dispatchKg}, 0) ELSE weight_kg END
            WHERE id = ${id}`;
          const updated = await sql`SELECT * FROM lots WHERE id = ${id}`;
          return res.status(200).json({ lot: updated[0], partial: true });
        }
        // Otherwise: dispatchQty/Kg ≥ on-hand → fall through and mark shipped.
        b.status = 'shipped';
      }

      // FULL dispatch path: status is being set to 'shipped'. Insert the audit
      // row using the lot's current remaining qty/weight (the bit being shipped).
      if (b.status === 'shipped') {
        const cur = await sql`SELECT quantity, weight_kg, unit FROM lots WHERE id = ${id}`;
        if (cur.length === 1) {
          const dq = dispatchQty ?? (cur[0].quantity  != null ? Number(cur[0].quantity)  : null);
          const dk = dispatchKg  ?? (cur[0].weight_kg != null ? Number(cur[0].weight_kg) : null);
          await sql`INSERT INTO dispatches
            (lot_id, quantity, weight_kg, unit, customer, dispatch_temp_c, operator, notes, client_id)
            VALUES (${id}, ${dq}, ${dk}, ${cur[0].unit}, ${customer},
                    ${dispatchTemp}, ${operatorName}, ${b.notes || null}, ${b.client_id || null})`;
        }
      }

      // COALESCE-merge pattern: only the keys present in the body change; a
      // missing key keeps the existing value, an explicit null clears it.
      // Dispatch convenience: marking a lot 'shipped' auto-stamps dispatched_at
      // (now) unless the caller passed one explicitly — so the QA brief gets a
      // real per-day dispatch time without the client having to send a clock.
      if (b.status === 'shipped' && !('dispatched_at' in b)) {
        b.dispatched_at = new Date().toISOString();
      }
      const has = (k) => k in b;
      const val = (k) => (b[k] === '' ? null : b[k]);
      if (!['status', 'use_by', 'weight_kg', 'quantity', 'notes', 'container',
            'dispatched_at', 'customer', 'dispatch_temp_c'].some(has)) {
        return res.status(400).json({ error: 'Nothing to update' });
      }
      const rows = await sql`
        UPDATE lots SET
          status          = CASE WHEN ${has('status')}          THEN ${val('status')}             ELSE status          END,
          use_by          = CASE WHEN ${has('use_by')}          THEN ${val('use_by')}::date      ELSE use_by          END,
          weight_kg       = CASE WHEN ${has('weight_kg')}       THEN ${val('weight_kg')}::numeric ELSE weight_kg       END,
          quantity        = CASE WHEN ${has('quantity')}        THEN ${val('quantity')}::numeric  ELSE quantity        END,
          notes           = CASE WHEN ${has('notes')}           THEN ${val('notes')}              ELSE notes           END,
          container       = CASE WHEN ${has('container')}       THEN ${val('container')}          ELSE container       END,
          dispatched_at   = CASE WHEN ${has('dispatched_at')}   THEN ${val('dispatched_at')}::timestamptz ELSE dispatched_at END,
          customer        = CASE WHEN ${has('customer')}        THEN ${val('customer')}           ELSE customer        END,
          dispatch_temp_c = CASE WHEN ${has('dispatch_temp_c')} THEN ${val('dispatch_temp_c')}::numeric ELSE dispatch_temp_c END
        WHERE id = ${id}
        RETURNING *`;
      if (rows.length === 0) return res.status(404).json({ error: 'Lot not found' });
      return res.status(200).json({ lot: rows[0] });
    }

    if (req.method === 'DELETE') {
      if (!requireAdminPin(req, res)) return;
      const id = Number(req.query.id || (req.body || {}).id);
      if (!id) return res.status(400).json({ error: 'Missing id' });
      await sql`DELETE FROM lots WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('lots error', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
