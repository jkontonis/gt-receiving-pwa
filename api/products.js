import { ensureSchema, sql } from './_db.js';

function requireAdminPin(req, res) {
  const expected = process.env.ADMIN_PIN;
  if (!expected) { res.status(500).json({ error: 'Server misconfigured: ADMIN_PIN not set' }); return false; }
  const got = req.headers['x-admin-pin'];
  if (got !== expected) { res.status(401).json({ error: 'Unauthorized — admin PIN required' }); return false; }
  return true;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (req.method === 'GET') {
      const r = await sql`SELECT canonical_name, aliases, unit, default_supplier,
        kind, shelf_life_days, gtin, units_per_carton, category
        FROM products ORDER BY canonical_name`;
      return res.status(200).json({ products: r });
    }
    if (req.method === 'POST') {
      if (!requireAdminPin(req, res)) return;
      const b = req.body || {};
      if (!b.canonical_name) return res.status(400).json({ error: 'canonical_name is required' });
      const r = await sql`
        INSERT INTO products (canonical_name, aliases, unit, default_supplier,
          kind, shelf_life_days, gtin, units_per_carton, category)
        VALUES (${b.canonical_name}, ${b.aliases || null}, ${b.unit || null}, ${b.default_supplier || null},
          ${b.kind || 'raw'}, ${b.shelf_life_days != null ? Number(b.shelf_life_days) : 7},
          ${b.gtin || null}, ${b.units_per_carton != null ? Number(b.units_per_carton) : null},
          ${b.category || null})
        ON CONFLICT (canonical_name) DO UPDATE SET
          aliases = EXCLUDED.aliases,
          unit = EXCLUDED.unit,
          default_supplier = EXCLUDED.default_supplier,
          kind = EXCLUDED.kind,
          shelf_life_days = EXCLUDED.shelf_life_days,
          gtin = EXCLUDED.gtin,
          units_per_carton = EXCLUDED.units_per_carton,
          category = EXCLUDED.category
        RETURNING canonical_name`;
      return res.status(201).json({ ok: true, canonical_name: r[0].canonical_name });
    }
    if (req.method === 'PATCH') {
      if (!requireAdminPin(req, res)) return;
      const b = req.body || {};
      const oldName = b.old_canonical_name || b.canonical_name;
      const newName = b.canonical_name;
      if (!oldName) return res.status(400).json({ error: 'canonical_name (or old_canonical_name) is required' });
      if (b.old_canonical_name && newName && b.old_canonical_name !== newName) {
        const clash = await sql`SELECT canonical_name FROM products WHERE canonical_name = ${newName}`;
        if (clash.length) return res.status(409).json({ error: 'Another product already uses that name.' });
        await sql`UPDATE receipts SET product = ${newName} WHERE product = ${oldName}`;
        await sql`UPDATE product_barcodes SET product = ${newName} WHERE product = ${oldName}`;
      }
      await sql`UPDATE products SET
        canonical_name = COALESCE(${newName}, canonical_name),
        aliases = COALESCE(${b.aliases}, aliases),
        unit = COALESCE(${b.unit}, unit),
        default_supplier = COALESCE(${b.default_supplier}, default_supplier),
        kind = COALESCE(${b.kind}, kind),
        shelf_life_days = COALESCE(${b.shelf_life_days != null ? Number(b.shelf_life_days) : null}, shelf_life_days),
        gtin = COALESCE(${b.gtin}, gtin),
        units_per_carton = COALESCE(${b.units_per_carton != null ? Number(b.units_per_carton) : null}, units_per_carton),
        category = COALESCE(${b.category}, category)
        WHERE canonical_name = ${oldName}`;
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'DELETE') {
      if (!requireAdminPin(req, res)) return;
      const name = (req.query && req.query.canonical_name) || (req.body && req.body.canonical_name);
      if (!name) return res.status(400).json({ error: 'canonical_name is required' });
      const delProduct = await sql`DELETE FROM products WHERE canonical_name = ${name} RETURNING canonical_name`;
      if (delProduct.length === 0) return res.status(404).json({ error: 'Product not found' });
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}
