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

-- ---------------------------------------------------------------------------
-- Lot genealogy / internal labelling (boning-room traceability).
-- ---------------------------------------------------------------------------

-- Product attributes for the processing room.
ALTER TABLE products ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'raw';            -- 'raw' | 'processed' | 'ingredient'
ALTER TABLE products ADD COLUMN IF NOT EXISTS shelf_life_days INT NOT NULL DEFAULT 7;      -- days allowed after bone-out (capped at source UBD)
ALTER TABLE products ADD COLUMN IF NOT EXISTS gtin TEXT;                                    -- GS1 GTIN off the supplier label
ALTER TABLE products ADD COLUMN IF NOT EXISTS units_per_carton INT;                        -- pack profile (piece counts)

-- Every quantity of stock is a lot: received from a supplier, or produced internally.
CREATE TABLE IF NOT EXISTS lots (
  id              SERIAL PRIMARY KEY,
  lot_code        TEXT UNIQUE NOT NULL,
  product         TEXT NOT NULL,
  origin          TEXT NOT NULL DEFAULT 'received',  -- 'received' | 'produced'
  status          TEXT NOT NULL DEFAULT 'available', -- 'wip' | 'available' | 'consumed' | 'shipped'
  supplier        TEXT,
  supplier_batch  TEXT,
  kill_date       DATE,
  production_date DATE,
  use_by          DATE,
  quantity        NUMERIC,
  unit            TEXT,
  weight_kg       NUMERIC,
  container       TEXT,
  receipt_id      INT,
  notes           TEXT,
  photo           TEXT,                              -- docket photo (received lots), base64 data URL
  client_id       TEXT,                              -- offline replay de-dupe key
  dispatched_at   TIMESTAMPTZ,                       -- when shipped (null until dispatched)
  customer        TEXT,                              -- dispatch destination (e.g. 'Brooklyn (P00675)')
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lots_product ON lots(product);
CREATE INDEX IF NOT EXISTS idx_lots_status ON lots(status);
CREATE INDEX IF NOT EXISTS idx_lots_supplier ON lots(supplier);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lots_client_id ON lots(client_id) WHERE client_id IS NOT NULL;

-- A process event consumes input lots and produces output lots. The link is the genealogy edge.
CREATE TABLE IF NOT EXISTS process_events (
  id           SERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,        -- 'bone_out' | 'portion' | 'slice' | 'crumb' | ...
  process_date DATE NOT NULL,
  operator     TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS process_inputs (
  id        SERIAL PRIMARY KEY,
  event_id  INT NOT NULL REFERENCES process_events(id) ON DELETE CASCADE,
  lot_id    INT NOT NULL REFERENCES lots(id),
  weight_kg NUMERIC,
  quantity  NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_process_inputs_event ON process_inputs(event_id);
CREATE INDEX IF NOT EXISTS idx_process_inputs_lot ON process_inputs(lot_id);

CREATE TABLE IF NOT EXISTS process_outputs (
  id       SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES process_events(id) ON DELETE CASCADE,
  lot_id   INT NOT NULL REFERENCES lots(id)
);
CREATE INDEX IF NOT EXISTS idx_process_outputs_event ON process_outputs(event_id);
CREATE INDEX IF NOT EXISTS idx_process_outputs_lot ON process_outputs(lot_id);
