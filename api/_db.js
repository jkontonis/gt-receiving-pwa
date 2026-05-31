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
