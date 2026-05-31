-- Optional: run once in the Neon/Vercel Postgres SQL console.
-- The first request to any /api route also runs these IF NOT EXISTS automatically.

CREATE TABLE IF NOT EXISTS suppliers (
  id        SERIAL PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL,
  code      TEXT,
  status    TEXT NOT NULL DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS products (
  id               SERIAL PRIMARY KEY,
  canonical_name   TEXT UNIQUE NOT NULL,
  aliases          TEXT,
  unit             TEXT,
  default_supplier TEXT
);

-- Many supplier barcodes -> one of our product names. Learned on first scan.
CREATE TABLE IF NOT EXISTS product_barcodes (
  barcode    TEXT PRIMARY KEY,
  product    TEXT NOT NULL,
  supplier   TEXT,
  unit       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS receipts (
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
);

CREATE INDEX IF NOT EXISTS idx_receipts_received_on ON receipts(received_on);
CREATE INDEX IF NOT EXISTS idx_receipts_batch ON receipts(batch_number);
CREATE INDEX IF NOT EXISTS idx_receipts_supplier ON receipts(supplier);
CREATE INDEX IF NOT EXISTS idx_receipts_product ON receipts(product);

INSERT INTO suppliers (name, code, status) VALUES
  ('Inghams', 'ING', 'Active'),
  ('Turi Foods', 'TURI', 'Active'),
  ('Hazeldenes', 'HAZ', 'Active'),
  ('La Ionica', 'LAI', 'Active')
ON CONFLICT (name) DO NOTHING;

INSERT INTO products (canonical_name, aliases, unit) VALUES
  ('Chicken Maryland',      'Maryland; Leg Quarter',       'kg'),
  ('Chicken Breast Fillet', 'Breast; BSF',                 'kg'),
  ('Chicken Thigh Fillet',  'Thigh; BST; Boneless Thigh',  'kg'),
  ('Whole Chicken Size 16', 'Size 16; 1.6kg bird',         'carton')
ON CONFLICT (canonical_name) DO NOTHING;
