-- ============================================================================
-- Clear the worked-example TEST DATA before going live.
-- Run this ONCE in the Neon SQL console (Neon dashboard -> SQL Editor).
--
-- It wipes the genealogy tables (lots + process events/links) but LEAVES the
-- reference data intact (suppliers, products, learned barcodes). Safe to run on
-- an empty DB too.
--
-- NOTE: the Neon SQL editor does NOT allow BEGIN/COMMIT (transaction control),
-- so there's no transaction wrapper here. Run the statements top to bottom; a
-- single TRUNCATE ... CASCADE is atomic on its own. One TRUNCATE across all
-- four tables avoids any FK ordering issues.
-- ============================================================================

-- Clear lots + all process events/links in one shot. CASCADE follows the FKs
-- from lots into process_inputs/process_outputs; listing process_events too
-- makes sure the events themselves go. RESTART IDENTITY resets the id counters
-- so the first real lot is id 1 again (clean GT-YYMMDD-001 lot code).
TRUNCATE TABLE lots, process_events, process_inputs, process_outputs RESTART IDENTITY CASCADE;

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
