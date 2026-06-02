import { neon } from '@neondatabase/serverless';

const connStr =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

export const sql = neon(connStr);

let inited = false;
export async function ensureSchema() {
  if (inited) return;

  await sql`CREATE TABLE IF NOT EXISTS suppliers (
    id        SERIAL PRIMARY KEY,
    name      TEXT UNIQUE NOT NULL,
    code      TEXT,
    status    TEXT NOT NULL DEFAULT 'Active'
  )`;

  await sql`CREATE TABLE IF NOT EXISTS products (
    id              SERIAL PRIMARY KEY,
    canonical_name  TEXT UNIQUE NOT NULL,
    aliases         TEXT,
    unit            TEXT,
    default_supplier TEXT
  )`;

  // A scanned supplier barcode maps to one of our product names. Suppliers each
  // use their own barcode for the same product, so this is a many-barcodes ->
  // one-product lookup table. Learned automatically the first time a barcode is
  // scanned and a product is confirmed for it.
  await sql`CREATE TABLE IF NOT EXISTS product_barcodes (
    barcode   TEXT PRIMARY KEY,
    product   TEXT NOT NULL,
    supplier  TEXT,
    unit      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS receipts (
    id            SERIAL PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_on   DATE NOT NULL,
    received_ts   TIMESTAMPTZ,
    barcode       TEXT,
    product       TEXT NOT NULL,
    supplier      TEXT,
    quantity      NUMERIC,
    unit          TEXT,
    weight_kg     NUMERIC,
    batch_number  TEXT,
    use_by        DATE,
    notes         TEXT,
    client_id     TEXT,
    photo         TEXT
  )`;

  await sql`CREATE INDEX IF NOT EXISTS idx_receipts_received_on ON receipts(received_on)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_receipts_batch ON receipts(batch_number)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_receipts_supplier ON receipts(supplier)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_receipts_product ON receipts(product)`;

  // ---------------------------------------------------------------------------
  // Lot genealogy / internal labelling (the boning-room traceability model).
  // ---------------------------------------------------------------------------

  // Extend products with the attributes the processing room needs. ADD COLUMN
  // IF NOT EXISTS is idempotent, so this is safe to run on every cold start.
  //  - kind:             'raw' (whole bird), 'processed' (a cut/portion we make),
  //                      or 'ingredient' (crumb/batter — carries its own batch).
  //  - shelf_life_days:  days we allow after bone-out, capped at the source UBD.
  //  - gtin:             GS1 GTIN from the supplier label (for scan auto-match).
  //  - units_per_carton: pack profile to derive piece counts (never scan birds).
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'raw'`;
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS shelf_life_days INT NOT NULL DEFAULT 7`;
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS gtin TEXT`;
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS units_per_carton INT`;
  // Process CATEGORY — drives event guardrails (what can be boned/sliced/crumbed)
  // reliably, instead of fragile name-matching on supplier product names.
  //   'whole_bird' | 'breast' | 'sliced_breast' | 'batter' | 'crumb' | 'other'
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT`;
  // One-time best-effort auto-classify — only runs when there are UNcategorised
  // products, so it's skipped on every normal cold start (was 6 full-table scans
  // per request, a needless drag). Once everything has a category, this no-ops.
  const uncat = await sql`SELECT COUNT(*)::int AS n FROM products WHERE category IS NULL`;
  if (uncat[0].n > 0) {
    await sql`UPDATE products SET category = 'whole_bird'
      WHERE category IS NULL AND (canonical_name ILIKE '%boning bird%' OR canonical_name ILIKE '%wbird%'
        OR canonical_name ILIKE '%whole chicken%' OR canonical_name ILIKE '%pallecon%' OR canonical_name ILIKE '%bin%')`;
    await sql`UPDATE products SET category = 'sliced_breast'
      WHERE category IS NULL AND canonical_name ILIKE '%sliced%' AND canonical_name ILIKE '%breast%'`;
    await sql`UPDATE products SET category = 'batter'
      WHERE category IS NULL AND canonical_name ILIKE '%batter%'`;
    // Breadcrumb/panko coating INGREDIENT only — NOT finished "Crumbed Schnitzel"
    // products (those are outputs, category 'other'). Exclude schnitzels here.
    await sql`UPDATE products SET category = 'crumb'
      WHERE category IS NULL AND canonical_name NOT ILIKE '%schnitzel%'
        AND (canonical_name ILIKE '%breadcrumb%' OR canonical_name ILIKE '%panko%' OR canonical_name ILIKE '%crumb%')`;
    await sql`UPDATE products SET category = 'breast'
      WHERE category IS NULL AND (canonical_name ILIKE '%breast%'
        OR canonical_name ILIKE '%br/fillet%' OR canonical_name ILIKE '%br fillet%')`;
    await sql`UPDATE products SET category = 'other' WHERE category IS NULL`;
  }

  // Every physical quantity of stock is a LOT — either RECEIVED from a supplier
  // (incoming WIP) or PRODUCED internally by a process event. Produced lots carry
  // a use-by date down from their source (never reset fresh).
  await sql`CREATE TABLE IF NOT EXISTS lots (
    id              SERIAL PRIMARY KEY,
    lot_code        TEXT UNIQUE NOT NULL,
    product         TEXT NOT NULL,
    origin          TEXT NOT NULL DEFAULT 'received',  -- 'received' | 'produced'
    status          TEXT NOT NULL DEFAULT 'available', -- 'wip' | 'available' | 'consumed' | 'shipped'
    supplier        TEXT,                              -- received lots
    supplier_batch  TEXT,                              -- supplier's own lot/batch off their label
    kill_date       DATE,                              -- supplier kill/slaughter date (received)
    production_date DATE,                              -- received date, or bone-out date (produced)
    use_by          DATE,                              -- UBD; carried down on produced lots
    quantity        NUMERIC,
    unit            TEXT,
    weight_kg       NUMERIC,
    container       TEXT,                              -- e.g. 'FB4 bin'
    receipt_id      INT,                               -- optional link to the receipts row
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  // Docket photo (received lots) + offline de-dupe key. ADD COLUMN IF NOT EXISTS
  // keeps this safe to run on every cold start. client_id lets the app replay a
  // queued lot after coming back online without creating a duplicate.
  await sql`ALTER TABLE lots ADD COLUMN IF NOT EXISTS photo TEXT`;
  await sql`ALTER TABLE lots ADD COLUMN IF NOT EXISTS client_id TEXT`;
  // Cold-chain: arrival temperature as real data (received lots) + out-of-spec flag.
  await sql`ALTER TABLE lots ADD COLUMN IF NOT EXISTS temp_c NUMERIC`;
  await sql`ALTER TABLE lots ADD COLUMN IF NOT EXISTS temp_ok BOOLEAN`;
  // Who created the lot (operator/worker) — audit "who".
  await sql`ALTER TABLE lots ADD COLUMN IF NOT EXISTS operator TEXT`;
  // PrimeSafe site that did the work (e.g. 'Flemington P01491' / 'Brooklyn P00675').
  await sql`ALTER TABLE lots ADD COLUMN IF NOT EXISTS site TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_lots_product ON lots(product)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_lots_status ON lots(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_lots_supplier ON lots(supplier)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_lots_client_id ON lots(client_id) WHERE client_id IS NOT NULL`;

  // A process event consumes one or more input lots and produces one or more
  // output lots. The input<->output link IS the genealogy edge. A crumbed
  // schnitzel therefore has TWO parents (sliced breast lot + crumb lot).
  await sql`CREATE TABLE IF NOT EXISTS process_events (
    id            SERIAL PRIMARY KEY,
    event_type    TEXT NOT NULL,            -- 'bone_out' | 'portion' | 'slice' | 'crumb' | ...
    process_date  DATE NOT NULL,
    operator      TEXT,
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  // Auto-captured bone/trim/loss (input kg − output kg) for yield analysis.
  await sql`ALTER TABLE process_events ADD COLUMN IF NOT EXISTS loss_kg NUMERIC`;
  // Variable coating: how many batter coats + crumb coats on a crumb event
  // (double-batter/double-crumb, single/double, single/single).
  await sql`ALTER TABLE process_events ADD COLUMN IF NOT EXISTS batter_coats INT`;
  await sql`ALTER TABLE process_events ADD COLUMN IF NOT EXISTS crumb_coats INT`;

  // Worker / operator register — the "who" for audit defence. Managed in-app
  // (Settings → Manage workers), admin-PIN gated.
  await sql`CREATE TABLE IF NOT EXISTS workers (
    id         SERIAL PRIMARY KEY,
    worker_id  TEXT UNIQUE NOT NULL,        -- e.g. staff code from GT-QC-00
    name       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'Active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS process_inputs (
    id          SERIAL PRIMARY KEY,
    event_id    INT NOT NULL REFERENCES process_events(id) ON DELETE CASCADE,
    lot_id      INT NOT NULL REFERENCES lots(id),
    weight_kg   NUMERIC,
    quantity    NUMERIC
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_process_inputs_event ON process_inputs(event_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_process_inputs_lot ON process_inputs(lot_id)`;

  await sql`CREATE TABLE IF NOT EXISTS process_outputs (
    id          SERIAL PRIMARY KEY,
    event_id    INT NOT NULL REFERENCES process_events(id) ON DELETE CASCADE,
    lot_id      INT NOT NULL REFERENCES lots(id)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_process_outputs_event ON process_outputs(event_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_process_outputs_lot ON process_outputs(lot_id)`;

  const existing = await sql`SELECT COUNT(*)::int AS n FROM suppliers`;
  if (existing[0].n === 0) {
    await sql`INSERT INTO suppliers (name, code, status) VALUES
      ('Inghams', 'ING', 'Active'),
      ('Turi Foods', 'TURI', 'Active'),
      ('Hazeldenes', 'HAZ', 'Active'),
      ('La Ionica', 'LAI', 'Active')`;
    await sql`INSERT INTO products (canonical_name, aliases, unit, default_supplier) VALUES
      ('Chicken Maryland',        'Maryland; Leg Quarter',          'kg',     NULL),
      ('Chicken Breast Fillet',   'Breast; BSF',                    'kg',     NULL),
      ('Chicken Thigh Fillet',    'Thigh; BST; Boneless Thigh',     'kg',     NULL),
      ('Whole Chicken Size 16',   'Size 16; 1.6kg bird',            'carton', NULL)`;
  }
  inited = true;
}

// Generate a unique internal lot code: GT-YYMMDD-NNN (date = production/received).
// We derive the numeric suffix from the row id after insert so it's collision-free
// and human-traceable on a printed label.
export function lotCodeFor(dateStr, id) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `GT-${yy}${mm}${dd}-${String(id).padStart(3, '0')}`;
}

// Pick the earliest (most conservative) use-by from a set of date strings.
export function minDate(dates) {
  const valid = dates.filter(Boolean).map((d) => new Date(d)).filter((d) => !isNaN(d));
  if (valid.length === 0) return null;
  return new Date(Math.min(...valid.map((d) => d.getTime())));
}

// Format a Date as YYYY-MM-DD (UTC) for a DATE column.
export function isoDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return null;
  return dt.toISOString().slice(0, 10);
}
