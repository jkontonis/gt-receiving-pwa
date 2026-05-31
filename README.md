# G&T Chickens — Goods In (Receiving + Batch Tracking)

A PWA for booking in supplier deliveries by scanning the supplier's barcode with
a tablet camera, capturing the batch details needed for traceability. Sister app
to the pick-pack QC tracker — same stack, same look.

## What it does

- **Receive** (`/receive`) — scan the supplier barcode with the tablet camera
  (or a handheld USB/Bluetooth scanner, or type it). Captures:
  - Supplier, product, quantity + unit, total weight (catch-weight),
    batch / lot number, use-by date, optional notes and a photo of the docket.
  - Auto-stamps date + time of receipt.
  - **Barcode learning:** the first time a barcode is seen you pick the product;
    after that the same barcode auto-fills product/supplier/unit on every scan.
  - **Offline-capable:** if the floor drops connection, receipts queue in the
    browser (IndexedDB) and sync automatically when back online.
- **History** (`/history`) — recent deliveries, batch/product/supplier search,
  totals, and a count of stock expiring within 3 days. Use-by dates highlight
  amber (≤3 days) / red (expired).
- **Admin** (`/admin`, PIN-gated) — manage suppliers, the product master, and
  the learned barcode mappings; edit/delete receipts; export the period to CSV.

## Tech stack

- Static HTML + vanilla JS PWA (no build step), service worker for offline shell.
- Vercel serverless functions under `/api`, Postgres via `@neondatabase/serverless`.
- Designed for an Amazon Fire tablet (Silk browser, Add to Home Screen), same as
  the QC tracker.

## Local / deploy

See [DEPLOY.md](DEPLOY.md). In short: set `DATABASE_URL` + `ADMIN_PIN` env vars,
deploy to Vercel. Tables self-create on first request; `schema.sql` is the same
DDL if you'd rather seed manually.

## Notes

- Camera scanning uses the browser's built-in `BarcodeDetector`. It works on
  Chrome / Silk on Android (the Fire tablet). On browsers without it (e.g. some
  desktop Safari), the camera button falls back to manual / handheld entry.
- Camera + offline both require the app to be served over **https** (Vercel is).
