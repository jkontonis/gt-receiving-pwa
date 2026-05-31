# Deploy — G&T Receiving PWA

Mirrors the qc-tracker-pwa setup.

## 1. Database (Neon, Sydney region)

You can reuse the existing Neon project (a separate database/branch keeps
receiving data apart from QC) or create a new one. Copy the pooled connection
string.

## 2. Vercel project

1. Push this folder to a Git repo (e.g. `jkontonis/gt-receiving-pwa`, private).
2. Import into Vercel. Framework preset: **Other** (no build step).
3. Set Environment Variables (Production + Preview):
   - `DATABASE_URL` — the Neon connection string.
   - `ADMIN_PIN` — the PIN that unlocks `/admin` and edit/delete/export.
4. Deploy. The first request to any `/api` route creates the tables and seeds a
   few example suppliers/products.

## 3. On the Fire tablet

1. Open the deployed URL in Silk.
2. Menu → **Add to Home Screen** for an app-like, full-screen launch.
3. Open it once while online so the service worker caches the shell for offline.
4. Grant the **camera** permission the first time you tap "Scan with camera".

## Routes

- `/receive` — staff receiving screen (default / start page).
- `/history` — recent deliveries + batch search.
- `/admin` — PIN-gated management + CSV export.

## API

| Route            | Methods                | Auth        |
|------------------|------------------------|-------------|
| `/api/receipts`  | POST, GET, PATCH, DELETE | POST/GET open; PATCH/DELETE PIN |
| `/api/lookup`    | GET (`?barcode=`)      | open        |
| `/api/products`  | GET / POST·PATCH·DELETE | writes PIN  |
| `/api/suppliers` | GET / POST·PATCH·DELETE | writes PIN  |
| `/api/barcodes`  | GET·POST·DELETE        | PIN         |
| `/api/photo`     | GET (`?id=`)           | open        |
| `/api/export`    | GET (`?days=`)         | open (CSV)  |
| `/api/admin-check` | GET                  | PIN check   |
