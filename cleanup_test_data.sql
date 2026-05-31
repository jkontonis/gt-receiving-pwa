-- ============================================================================
-- Clear the worked-example TEST DATA before going live.
-- Run this ONCE in the Neon SQL console (Neon dashboard -> SQL Editor).
--
-- It wipes the genealogy tables (lots + process events/links) but LEAVES the
-- reference data intact (suppliers, products, learned barcodes). Safe to run on
-- an empty DB too. Order matters: children before parents because of the FKs.
-- ============================================================================

BEGIN;

-- process_inputs / process_outputs reference both process_events and lots, so
-- they go first. TRUNCATE ... CASCADE also clears anything pointing at them.
TRUNCATE TABLE process_outputs, process_inputs, process_events RESTART IDENTITY CASCADE;

-- Now the lots themselves (RESTART IDENTITY so the first real lot is id 1 again,
-- giving a clean GT-YYMMDD-001 lot code).
TRUNCATE TABLE lots RESTART IDENTITY CASCADE;

COMMIT;

-- OPTIONAL: if you also booked test deliveries through the old receipts flow and
-- want those gone, uncomment the next line:
-- TRUNCATE TABLE receipts RESTART IDENTITY;

-- OPTIONAL: remove any test barcode->product mappings learned during testing:
-- DELETE FROM product_barcodes WHERE created_at < NOW();  -- or target specific barcodes

-- Verify it's clean:
SELECT
  (SELECT COUNT(*) FROM lots)            AS lots,
  (SELECT COUNT(*) FROM process_events)  AS events,
  (SELECT COUNT(*) FROM process_inputs)  AS inputs,
  (SELECT COUNT(*) FROM process_outputs) AS outputs;
