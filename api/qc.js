import { ensureSchema, sql } from './_db.js';
import crypto from 'crypto';
import http2 from 'http2';

// Single QC endpoint, multiple actions — keeps us under Vercel Hobby's
// 12-function cap. Routing by method + ?action=:
//   POST  /api/qc                    → log a new error (public, no PIN)
//   GET   /api/qc?action=data        → dashboard aggregations (public)
//   GET   /api/qc?action=export      → CSV download (public)
//   GET   /api/qc?action=list        → admin list of last 100 errors (PIN)
//   PATCH /api/qc                    → edit one error by id (PIN)
//   DELETE /api/qc?id=N              → delete one error by id (PIN)

function requireAdminPin(req, res) {
  const expected = process.env.ADMIN_PIN;
  if (!expected) { res.status(500).json({ error: 'Server misconfigured: ADMIN_PIN not set' }); return false; }
  const got = req.headers['x-admin-pin'];
  if (got !== expected) { res.status(401).json({ error: 'Unauthorized — admin PIN required' }); return false; }
  return true;
}

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
  if (/[",]/.test(s) || /^\s|\s$/.test(s)) return '"' + s + '"';
  return s;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const action = (req.query.action || (req.method === 'GET' ? 'data' : '')).toLowerCase();

    // -----------------------------------------------------------------------
    // POST: log a new error (public, no PIN). Auto-creates the product in the
    // SKU master if it isn't there.
    // Also handles device-token registration when ?action=register_device.
    // -----------------------------------------------------------------------
    if (req.method === 'POST') {
      // Supplier invoice — create or update header + lines. Admin only.
      // Body: { id?, supplier, invoice_number, invoice_date, total_amount,
      //         notes, lines: [{ product, description, quantity, unit,
      //         unit_price, line_total }] }
      if (action === 'invoice_upsert') {
        if (!requireAdminPin(req, res)) return;
        const b = req.body || {};
        if (!b.supplier) return res.status(400).json({ error: 'supplier required' });
        let invoiceId = b.id ? parseInt(b.id, 10) : null;
        if (invoiceId) {
          await sql`UPDATE supplier_invoices SET
            supplier = ${b.supplier},
            invoice_number = ${b.invoice_number || null},
            invoice_date = ${b.invoice_date || null},
            total_amount = ${b.total_amount || null},
            notes = ${b.notes || null},
            status = COALESCE(${b.status}, status),
            site_id = COALESCE(${b.site_id}, site_id)
            WHERE id = ${invoiceId}`;
          // Replace lines wholesale on update (simplest semantics).
          await sql`DELETE FROM supplier_invoice_lines WHERE invoice_id = ${invoiceId}`;
        } else {
          const r = await sql`
            INSERT INTO supplier_invoices (supplier, invoice_number, invoice_date, total_amount, notes, site_id)
            VALUES (${b.supplier}, ${b.invoice_number || null}, ${b.invoice_date || null}, ${b.total_amount || null}, ${b.notes || null}, ${b.site_id || null})
            ON CONFLICT (supplier, invoice_number) DO UPDATE SET
              invoice_date = EXCLUDED.invoice_date,
              total_amount = EXCLUDED.total_amount,
              notes = EXCLUDED.notes
            RETURNING id`;
          invoiceId = r[0].id;
        }
        // Insert lines
        for (const ln of (b.lines || [])) {
          await sql`INSERT INTO supplier_invoice_lines
            (invoice_id, product, description, quantity, unit, unit_price, line_total)
            VALUES (${invoiceId}, ${ln.product || null}, ${ln.description || null},
                    ${ln.quantity || null}, ${ln.unit || null},
                    ${ln.unit_price || null}, ${ln.line_total || null})`;
        }
        return res.status(200).json({ ok: true, id: invoiceId });
      }

      // Sign off a cleaning task (no PIN — staff just tap the row).
      if (action === 'cleaning_signoff') {
        const b = req.body || {};
        if (!b.task_id || !b.worker_code) {
          return res.status(400).json({ error: 'task_id and worker_code are required' });
        }
        const dRow = await sql`SELECT (NOW() AT TIME ZONE 'Australia/Melbourne')::date AS today_mel`;
        const today = b.signed_on || dRow[0].today_mel;
        let photo = b.photo || null;
        if (photo && photo.length > 600 * 1024) return res.status(413).json({ error: 'Photo too large.' });
        // Validate the task exists + grab the requires_photo flag for safety.
        const t = await sql`SELECT id, requires_photo FROM cleaning_tasks WHERE id = ${b.task_id} AND active = TRUE`;
        if (t.length === 0) return res.status(404).json({ error: 'Cleaning task not found / inactive.' });
        if (t[0].requires_photo && !photo) {
          return res.status(400).json({ error: 'This task requires a photo on sign-off.' });
        }
        const r = await sql`
          INSERT INTO cleaning_signoffs (task_id, signed_on, worker_code, notes, photo, site_id, client_id)
          VALUES (${b.task_id}, ${today}, ${b.worker_code}, ${b.notes || null}, ${photo}, ${b.site_id || null}, ${b.client_id || null})
          RETURNING id, signed_at`;
        return res.status(200).json({ ok: true, id: r[0].id, signed_at: r[0].signed_at });
      }

      // Admin: create / update a cleaning task template.
      if (action === 'cleaning_task_upsert') {
        if (!requireAdminPin(req, res)) return;
        const b = req.body || {};
        if (!b.name || !b.frequency) return res.status(400).json({ error: 'name and frequency required' });
        if (b.id) {
          await sql`UPDATE cleaning_tasks SET
            name = ${b.name}, area = ${b.area || null}, frequency = ${b.frequency},
            requires_photo = ${b.requires_photo === true},
            active = ${b.active !== false},
            display_order = ${b.display_order || 0},
            site_id = ${b.site_id || null}
            WHERE id = ${b.id}`;
          return res.status(200).json({ ok: true, id: b.id });
        }
        const r = await sql`
          INSERT INTO cleaning_tasks (name, area, frequency, requires_photo, display_order, site_id)
          VALUES (${b.name}, ${b.area || null}, ${b.frequency}, ${b.requires_photo === true}, ${b.display_order || 0}, ${b.site_id || null})
          RETURNING id`;
        return res.status(201).json({ ok: true, id: r[0].id });
      }

      if (action === 'register_device') {
        const b = req.body || {};
        if (!b.token || !b.platform) return res.status(400).json({ error: 'token and platform are required' });
        const r = await sql`
          INSERT INTO devices (token, platform, bundle_id, site_id)
          VALUES (${b.token}, ${b.platform}, ${b.bundle_id || null}, ${b.site_id || null})
          ON CONFLICT (token) DO UPDATE SET
            platform = EXCLUDED.platform,
            bundle_id = COALESCE(EXCLUDED.bundle_id, devices.bundle_id),
            site_id = COALESCE(EXCLUDED.site_id, devices.site_id),
            last_seen_at = NOW(),
            enabled = TRUE
          RETURNING id`;
        return res.status(200).json({ ok: true, id: r[0].id });
      }
      const b = req.body || {};
      const required = ['occurred_at', 'product', 'stage', 'worker_code', 'error_type'];
      for (const f of required) {
        if (!b[f]) return res.status(400).json({ error: `Missing required field: ${f}` });
      }
      let photo = b.photo || null;
      if (photo && typeof photo === 'string' && photo.length > 600 * 1024) {
        return res.status(413).json({ error: 'Photo too large — please retake.' });
      }
      const productName = String(b.product).trim();
      await sql`INSERT INTO products (canonical_name) VALUES (${productName})
                ON CONFLICT (canonical_name) DO NOTHING`;
      // Complaint linkage: a complaint sets lot_id / lot_code + resolution ('open'
      // by default) so the row can later be marked credited/replaced/dismissed.
      const lotId = b.lot_id ? parseInt(b.lot_id, 10) : null;
      const lotCode = b.lot_code || null;
      const resolution = b.resolution || (lotId || lotCode ? 'open' : null);
      const result = await sql`
        INSERT INTO qc_errors (occurred_at, order_number, customer, product, stage, worker_code, error_type, caught_by, action_taken, notes, client_id, photo, site_id, lot_id, lot_code, resolution)
        VALUES (${b.occurred_at}, ${b.order_number || null}, ${b.customer || null}, ${productName}, ${b.stage}, ${b.worker_code}, ${b.error_type}, ${b.caught_by || null}, ${b.action_taken || null}, ${b.notes || null}, ${b.client_id || null}, ${photo}, ${b.site_id || null}, ${lotId}, ${lotCode}, ${resolution})
        RETURNING id, created_at
      `;
      return res.status(200).json({ ok: true, id: result[0].id, created_at: result[0].created_at });
    }

    // -----------------------------------------------------------------------
    // GET: dispatch by ?action=
    // -----------------------------------------------------------------------
    if (req.method === 'GET') {
      // UBD push check — Vercel Cron hits this morning + arvo. Sends a push
      // notification to every registered device when there's at least one lot
      // with a use-by today or earlier still in active stock. CRON_SECRET-gated.
      if (action === 'ubd_check') {
        const cronSecret = process.env.CRON_SECRET;
        const auth = req.headers['authorization'] || '';
        // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when configured.
        // We also accept the same secret via ?secret= for manual testing in browser.
        const okAuth = (cronSecret && (auth === `Bearer ${cronSecret}` || req.query.secret === cronSecret));
        if (!okAuth) return res.status(401).json({ error: 'Unauthorized — cron secret required' });

        const dRow = await sql`
          SELECT
            (NOW() AT TIME ZONE 'Australia/Melbourne')::date AS today_mel,
            ((NOW() AT TIME ZONE 'Australia/Melbourne')::date + 1) AS tomorrow_mel`;
        const todayMel = dRow[0].today_mel;
        const tomorrowMel = dRow[0].tomorrow_mel;

        // Active lots whose UBD is today or tomorrow.
        const urgent = await sql`
          SELECT id, lot_code, product, use_by
          FROM lots
          WHERE status IN ('wip', 'available')
            AND use_by IS NOT NULL
            AND use_by <= ${tomorrowMel}
          ORDER BY use_by ASC, id ASC`;

        if (urgent.length === 0) {
          return res.status(200).json({ ok: true, sent: 0, urgent: 0, note: 'No urgent lots — no push sent.' });
        }

        const devices = await sql`SELECT id, token, platform FROM devices WHERE enabled = TRUE AND platform = 'ios'`;
        if (devices.length === 0) {
          return res.status(200).json({ ok: true, sent: 0, urgent: urgent.length, note: 'No registered devices.' });
        }

        // Bucket the urgency for the body line.
        const expired = urgent.filter(l => new Date(l.use_by) < new Date(todayMel)).length;
        const today = urgent.filter(l => String(l.use_by).slice(0, 10) === String(todayMel).slice(0, 10)).length;
        const tomorrow = urgent.length - expired - today;
        const title = 'Use-by warning';
        const bodyParts = [];
        if (expired > 0)  bodyParts.push(`${expired} expired`);
        if (today > 0)    bodyParts.push(`${today} today`);
        if (tomorrow > 0) bodyParts.push(`${tomorrow} tomorrow`);
        const body = `${urgent.length} lot${urgent.length === 1 ? '' : 's'} (${bodyParts.join(' · ')}) need attention.`;

        const sent = await sendAPNsToDevices(devices, { title, body, badge: urgent.length });
        return res.status(200).json({ ok: true, urgent: urgent.length, devices: devices.length, sent });
      }

      // Lot lookup — used by the complaint flow to auto-fill worker / product /
      // supplier / customer-shipped-to / dispatch-temp from a single lot code or
      // id. Public (no PIN) because the complaint flow is staff-facing.
      if (action === 'lot_lookup') {
        const code = (req.query.code || '').trim();
        const idRaw = req.query.id ? parseInt(req.query.id, 10) : null;
        let rows;
        if (idRaw) {
          rows = await sql`SELECT id, lot_code, product, supplier, supplier_batch,
                                  kill_date, production_date, use_by, weight_kg, quantity, unit,
                                  operator AS operator_name, customer, dispatched_at, dispatch_temp_c,
                                  temp_c, status
                           FROM lots WHERE id = ${idRaw} LIMIT 1`;
        } else if (code) {
          rows = await sql`SELECT id, lot_code, product, supplier, supplier_batch,
                                  kill_date, production_date, use_by, weight_kg, quantity, unit,
                                  operator AS operator_name, customer, dispatched_at, dispatch_temp_c,
                                  temp_c, status
                           FROM lots WHERE lot_code = ${code} LIMIT 1`;
        } else {
          return res.status(400).json({ error: 'lot_lookup needs ?code= or ?id=' });
        }
        if (rows.length === 0) return res.status(200).json({ found: false });
        // Try to resolve operator_name → workers.worker_id so the iOS form can
        // pre-select the correct worker pill instead of just showing a name.
        const op = rows[0].operator_name;
        let workerCode = null;
        if (op) {
          const w = await sql`SELECT worker_id FROM workers WHERE name = ${op} OR worker_id = ${op} LIMIT 1`;
          if (w.length) workerCode = w[0].worker_id;
        }
        return res.status(200).json({ found: true, lot: rows[0], suggested_worker_code: workerCode });
      }

      // Supplier invoice — list recent invoices (admin only).
      if (action === 'invoice_list') {
        if (!requireAdminPin(req, res)) return;
        const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
        const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const rows = await sql`
          SELECT i.id, i.supplier, i.invoice_number, i.invoice_date, i.total_amount, i.status, i.notes,
                 (SELECT COUNT(*)::int FROM supplier_invoice_lines l WHERE l.invoice_id = i.id) AS line_count,
                 (SELECT COUNT(*)::int FROM supplier_invoice_lines l WHERE l.invoice_id = i.id
                    AND l.match_status IN ('over_qty','under_qty','no_match','price_diff')) AS discrepancy_count
          FROM supplier_invoices i
          WHERE i.invoice_date >= ${since} OR i.invoice_date IS NULL
          ORDER BY i.invoice_date DESC NULLS LAST, i.id DESC
          LIMIT 100`;
        return res.status(200).json({ invoices: rows });
      }

      // Supplier invoice — reconcile one invoice's lines against receipts on its
      // date (±2 days window). Updates each line with a match_status flag. Admin.
      if (action === 'invoice_reconcile') {
        if (!requireAdminPin(req, res)) return;
        const id = parseInt(req.query.id || '', 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const inv = await sql`SELECT id, supplier, invoice_date FROM supplier_invoices WHERE id = ${id}`;
        if (inv.length === 0) return res.status(404).json({ error: 'Invoice not found' });
        const { supplier, invoice_date } = inv[0];
        if (!invoice_date) {
          return res.status(400).json({ error: 'Invoice has no invoice_date — set it before reconciling.' });
        }
        const lines = await sql`SELECT id, product, description, quantity, unit FROM supplier_invoice_lines WHERE invoice_id = ${id}`;
        if (lines.length === 0) {
          return res.status(200).json({
            ok: true,
            summary: { matched: 0, over: 0, under: 0, no_match: 0 },
            has_issues: false,
            note: 'This invoice has no line items to reconcile. Add lines first or re-scan the invoice.'
          });
        }
        let matched = 0, over = 0, under = 0, noMatch = 0;
        for (const ln of lines) {
          // Match by supplier + product within ±2 days
          const cand = await sql`
            SELECT id, product, weight_kg, quantity, unit
            FROM receipts
            WHERE supplier = ${supplier}
              AND received_on BETWEEN (${invoice_date}::date - 2) AND (${invoice_date}::date + 2)
              AND (product ILIKE ${ln.product || ''} OR product ILIKE ${'%' + (ln.product || '') + '%'})
            ORDER BY received_on ASC
            LIMIT 1`;
          let status = 'no_match';
          let receiptId = null;
          let note = null;
          if (cand.length > 0) {
            receiptId = cand[0].id;
            const recQty = ln.unit === 'kg' ? Number(cand[0].weight_kg) : Number(cand[0].quantity);
            const invQty = Number(ln.quantity);
            if (!recQty || !invQty || isNaN(recQty) || isNaN(invQty)) {
              status = 'matched';
            } else {
              const diff = (invQty - recQty) / Math.max(recQty, 0.0001);
              if (Math.abs(diff) < 0.02) { status = 'matched'; matched++; }
              else if (diff > 0)       { status = 'over_qty';  over++;  note = `Invoice ${invQty} vs received ${recQty}`; }
              else                     { status = 'under_qty'; under++; note = `Invoice ${invQty} vs received ${recQty}`; }
            }
          } else {
            noMatch++;
          }
          await sql`UPDATE supplier_invoice_lines
            SET matched_receipt_id = ${receiptId},
                match_status = ${status},
                discrepancy_note = ${note}
            WHERE id = ${ln.id}`;
        }
        // Auto-mark invoice as reconciled if no discrepancies, else leave pending
        const hasIssues = over > 0 || under > 0 || noMatch > 0;
        if (!hasIssues) {
          await sql`UPDATE supplier_invoices SET status = 'reconciled' WHERE id = ${id}`;
        }
        return res.status(200).json({ ok: true, summary: { matched, over, under, no_match: noMatch }, has_issues: hasIssues });
      }

      // PrimeSafe Day Pack brief — pre-fills the gt-chickens-records-pack skill's
      // daily template from live data so John doesn't have to type the brief from
      // scratch. PIN-gated (compliance data).
      // ?date=YYYY-MM-DD (default: today in Melbourne) ?site=flemington|brooklyn
      if (action === 'day_pack_brief') {
        if (!requireAdminPin(req, res)) return;
        const dRow = await sql`SELECT (NOW() AT TIME ZONE 'Australia/Melbourne')::date AS today_mel`;
        const date = req.query.date || String(dRow[0].today_mel);

        // Receivals
        const receivals = await sql`
          SELECT lot_code, product, supplier, supplier_batch, weight_kg, quantity, unit,
                 temp_c, container
          FROM lots
          WHERE origin = 'received'
            AND created_at::date = ${date}::date
          ORDER BY id ASC`;

        // Boning / production: process events on the date
        const process = await sql`
          SELECT id, event_type, process_date, operator AS operator_name, notes,
                 batter_coats, crumb_coats
          FROM process_events
          WHERE process_date::date = ${date}::date
          ORDER BY id ASC`;

        // Dispatches: lots whose dispatched_at falls on the date
        const dispatches = await sql`
          SELECT lot_code, product, weight_kg, quantity, unit, customer,
                 dispatch_temp_c, dispatched_at
          FROM lots
          WHERE dispatched_at IS NOT NULL
            AND (dispatched_at AT TIME ZONE 'Australia/Melbourne')::date = ${date}::date
          ORDER BY dispatched_at ASC`;

        // QC errors logged on the date (becomes the NCs section)
        const ncs = await sql`
          SELECT id, worker_code, product, stage, error_type, customer,
                 caught_by, lot_code, resolution, notes
          FROM qc_errors
          WHERE occurred_at = ${date}
          ORDER BY id ASC`;

        // Cleaning sign-offs on the date
        const cleaning = await sql`
          SELECT s.id, t.name AS task_name, t.frequency, s.worker_code, s.signed_at
          FROM cleaning_signoffs s
          JOIN cleaning_tasks t ON t.id = s.task_id
          WHERE s.signed_on = ${date}
          ORDER BY s.signed_at ASC`;

        // Workers list — we don't track attendance, so list all active.
        const workers = await sql`
          SELECT worker_id, name, role FROM workers WHERE status = 'Active' ORDER BY name`;

        // Day-of-week + formatted date for the brief header.
        const dayInfo = await sql`
          SELECT TO_CHAR(${date}::date, 'Dy') AS dow, TO_CHAR(${date}::date, 'DD/MM/YYYY') AS au_date`;

        // Build the human-readable brief in the skill's expected format.
        const lines = [];
        lines.push(`[DAY] — ${dayInfo[0].dow} ${dayInfo[0].au_date}`);
        lines.push('');
        lines.push('RECEIVALS:');
        if (receivals.length === 0) {
          lines.push('- NIL');
        } else {
          for (const r of receivals) {
            const w = r.weight_kg ? `${Number(r.weight_kg).toFixed(0)} kg` : '';
            const t = r.temp_c != null ? `probe ${Number(r.temp_c).toFixed(1)}°C` : '';
            const parts = [
              r.supplier || 'unknown supplier',
              r.supplier_batch ? `batch ${r.supplier_batch}` : '',
              r.lot_code, r.product, w, t
            ].filter(Boolean);
            lines.push('- ' + parts.join(' · '));
          }
        }
        lines.push('');
        lines.push('PRODUCTION / BONING:');
        if (process.length === 0) {
          lines.push('- NIL');
        } else {
          for (const p of process) {
            const coats = (p.batter_coats || p.crumb_coats)
              ? ` (batter ${p.batter_coats || 0}, crumb ${p.crumb_coats || 0})` : '';
            lines.push(`- ${p.event_type}${coats}${p.operator_name ? ` · ${p.operator_name}` : ''}${p.notes ? ` · ${p.notes}` : ''}`);
          }
        }
        lines.push('');
        lines.push('DISPATCHES:');
        if (dispatches.length === 0) {
          lines.push('- NIL');
        } else {
          for (const d of dispatches) {
            const t = d.dispatch_temp_c != null ? `probe ${Number(d.dispatch_temp_c).toFixed(1)}°C` : '';
            const w = d.weight_kg ? `${Number(d.weight_kg).toFixed(0)} kg` : '';
            const time = d.dispatched_at ? new Date(d.dispatched_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Australia/Melbourne' }) : '';
            lines.push(`- ${time} ${d.lot_code} · ${d.product} · ${w} · ${t} · → ${d.customer || 'unspecified'}`);
          }
        }
        lines.push('');
        lines.push('PERSONNEL ON SITE:');
        lines.push(`- Active roster: ${workers.map(w => `${w.worker_id} (${w.name})`).join(', ') || 'none registered'}`);
        lines.push('- Visitors / contractors: [FILL IN]');
        lines.push('');
        lines.push('MAINTENANCE / VISITS:');
        lines.push('- [FILL IN — maintenance not tracked in app yet]');
        lines.push('');
        lines.push('NCs / HOLDS / COMPLAINTS:');
        if (ncs.length === 0) {
          lines.push('- NIL');
        } else {
          for (const n of ncs) {
            const isComplaint = !!n.lot_code;
            const tag = isComplaint ? 'COMPLAINT' : 'NC';
            lines.push(`- ${tag} #${n.id} · ${n.product} · ${n.stage}/${n.error_type} · worker ${n.worker_code}${n.customer ? ` · customer ${n.customer}` : ''}${n.lot_code ? ` · lot ${n.lot_code}` : ''}${n.resolution ? ` · ${n.resolution}` : ''}${n.notes ? ` — ${n.notes}` : ''}`);
          }
        }
        lines.push('');
        lines.push('CLEANING SIGN-OFFS:');
        if (cleaning.length === 0) {
          lines.push('- NIL');
        } else {
          for (const c of cleaning) {
            lines.push(`- ${c.task_name} (${c.frequency}) · ${c.worker_code || 'unknown'}`);
          }
        }
        lines.push('');
        lines.push('CARRY-OVER CHANGES:');
        lines.push('- [FILL IN — long-running items, audit findings, F11/F13 due dates]');
        lines.push('');
        lines.push('NOTES / FLAGS:');
        lines.push('- [FILL IN — anything to highlight]');

        const brief = lines.join('\n');
        const wantsText = (req.query.format || 'json') === 'text';
        if (wantsText) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="day-pack-brief-${date}.txt"`);
          return res.status(200).send(brief);
        }
        return res.status(200).json({
          date,
          brief,
          counts: {
            receivals: receivals.length,
            process_events: process.length,
            dispatches: dispatches.length,
            ncs: ncs.length,
            cleaning: cleaning.length,
            workers: workers.length,
          },
          structured: { receivals, process, dispatches, ncs, cleaning, workers }
        });
      }

      // Cleaning checklist for today — task templates with their done/pending
      // status for the current Melbourne date. Daily tasks every day; weekly
      // tasks if no sign-off in the last 7 days; monthly if no sign-off in 28.
      if (action === 'cleaning_today') {
        const dRow = await sql`
          SELECT
            (NOW() AT TIME ZONE 'Australia/Melbourne')::date AS today_mel,
            ((NOW() AT TIME ZONE 'Australia/Melbourne')::date - 6) AS week_ago,
            ((NOW() AT TIME ZONE 'Australia/Melbourne')::date - 27) AS month_ago`;
        const todayMel = dRow[0].today_mel;
        const weekAgo = dRow[0].week_ago;
        const monthAgo = dRow[0].month_ago;
        // Pull tasks + most-recent sign-off in one query for the relevant window.
        const rows = await sql`
          SELECT t.id, t.name, t.area, t.frequency, t.requires_photo, t.display_order,
                 (SELECT MAX(signed_on) FROM cleaning_signoffs s WHERE s.task_id = t.id) AS last_signed_on,
                 (SELECT s.worker_code FROM cleaning_signoffs s
                   WHERE s.task_id = t.id ORDER BY signed_at DESC LIMIT 1) AS last_signed_by
          FROM cleaning_tasks t
          WHERE t.active = TRUE
          ORDER BY t.frequency, t.display_order, t.id`;
        // Annotate each row with whether it's currently due.
        const tasks = rows.map(t => {
          const last = t.last_signed_on ? String(t.last_signed_on).slice(0, 10) : null;
          let due = true;
          if (last) {
            if (t.frequency === 'daily')   due = last !== String(todayMel).slice(0, 10);
            if (t.frequency === 'weekly')  due = new Date(last) < new Date(weekAgo);
            if (t.frequency === 'monthly') due = new Date(last) < new Date(monthAgo);
          }
          return { ...t, due, today: todayMel };
        });
        return res.status(200).json({ today: todayMel, tasks });
      }

      // Recent cleaning sign-offs — for the History → Cleaning view.
      if (action === 'cleaning_history') {
        const days = Math.min(Math.max(parseInt(req.query.days || '14', 10) || 14, 1), 365);
        const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const rows = await sql`
          SELECT s.id, s.task_id, s.signed_at, s.signed_on, s.worker_code, s.notes,
                 (s.photo IS NOT NULL) AS has_photo, s.site_id,
                 t.name AS task_name, t.area, t.frequency
          FROM cleaning_signoffs s
          JOIN cleaning_tasks t ON t.id = s.task_id
          WHERE s.signed_on >= ${since}
          ORDER BY s.signed_at DESC
          LIMIT 200`;
        return res.status(200).json({ signoffs: rows, days });
      }

      // Morning brief — one-screen "what happened yesterday, what needs my
      // attention today" payload. Includes:
      //   - yesterday's QC totals + worst worker / stage / product
      //   - count of complaints still in open/investigating
      //   - lots whose UBD is today or tomorrow (priority list to move)
      //   - WIP lots older than 24h (suggesting boning-room bottleneck)
      // No PIN — staff-facing morning screen.
      if (action === 'brief') {
        // Anchor dates in Melbourne local time so "yesterday" lines up with the
        // physical shift, not UTC. occurred_at is stored as a DATE so direct ==
        // comparison works once the date is in Melbourne.
        const dRow = await sql`
          SELECT
            (NOW() AT TIME ZONE 'Australia/Melbourne')::date AS today_mel,
            ((NOW() AT TIME ZONE 'Australia/Melbourne')::date - 1) AS yesterday_mel,
            ((NOW() AT TIME ZONE 'Australia/Melbourne')::date + 1) AS tomorrow_mel
        `;
        const todayMel = dRow[0].today_mel;
        const yesterdayMel = dRow[0].yesterday_mel;
        const tomorrowMel = dRow[0].tomorrow_mel;

        const yTotal = await sql`SELECT COUNT(*)::int AS n FROM qc_errors WHERE occurred_at = ${yesterdayMel}`;
        const yWorstWorker = await sql`
          SELECT e.worker_code, COALESCE(w.name, e.worker_code) AS full_name, COUNT(*)::int AS n
          FROM qc_errors e LEFT JOIN workers w ON w.worker_id = e.worker_code
          WHERE e.occurred_at = ${yesterdayMel}
          GROUP BY e.worker_code, w.name
          ORDER BY n DESC LIMIT 1`;
        const yWorstStage = await sql`
          SELECT stage, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at = ${yesterdayMel}
          GROUP BY stage ORDER BY n DESC LIMIT 1`;
        const yWorstProduct = await sql`
          SELECT product, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at = ${yesterdayMel}
          GROUP BY product ORDER BY n DESC LIMIT 1`;
        const openComp = await sql`
          SELECT COUNT(*)::int AS n FROM qc_errors
          WHERE resolution IN ('open', 'investigating')`;

        // Lots that need attention today: UBD <= tomorrow, still active.
        // Sorted by use_by ascending so the most urgent appears first.
        const ubdWarning = await sql`
          SELECT id, lot_code, product, use_by, weight_kg, quantity, unit,
                 supplier, supplier_batch, status, customer
          FROM lots
          WHERE status IN ('wip', 'available')
            AND use_by IS NOT NULL
            AND use_by <= ${tomorrowMel}
          ORDER BY use_by ASC, id ASC
          LIMIT 50`;

        // WIP lots older than 24h — typically means the boning room hasn't
        // processed something it should have. Flag them so they don't rot.
        const wipStuck = await sql`
          SELECT id, lot_code, product, created_at, use_by, weight_kg, quantity, unit, supplier
          FROM lots
          WHERE status = 'wip'
            AND created_at < NOW() - INTERVAL '24 hours'
          ORDER BY created_at ASC
          LIMIT 50`;

        return res.status(200).json({
          today: todayMel,
          yesterday: yesterdayMel,
          yesterday_total_errors: yTotal[0].n,
          yesterday_worst_worker: yWorstWorker[0] || null,
          yesterday_worst_stage: yWorstStage[0] || null,
          yesterday_worst_product: yWorstProduct[0] || null,
          open_complaints: openComp[0].n,
          ubd_warning: ubdWarning,
          wip_stuck: wipStuck,
        });
      }

      const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

      if (action === 'data') {
        const total = await sql`SELECT COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${since}`;
        const byWorker = await sql`
          SELECT e.worker_code, COALESCE(w.name, e.worker_code) AS full_name, COUNT(*)::int AS n
          FROM qc_errors e LEFT JOIN workers w ON w.worker_id = e.worker_code
          WHERE e.occurred_at >= ${since}
          GROUP BY e.worker_code, w.name
          ORDER BY n DESC`;
        const byStage = await sql`
          SELECT stage, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${since}
          GROUP BY stage ORDER BY n DESC`;
        const byType = await sql`
          SELECT error_type, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${since}
          GROUP BY error_type ORDER BY n DESC`;
        const byProduct = await sql`
          SELECT product, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${since}
          GROUP BY product ORDER BY n DESC LIMIT 10`;
        const workerStage = await sql`
          SELECT worker_code, stage, COUNT(*)::int AS n FROM qc_errors WHERE occurred_at >= ${since}
          GROUP BY worker_code, stage`;
        const recent = await sql`
          SELECT id, created_at, occurred_at, order_number, customer, product, stage,
                 worker_code, error_type, caught_by, action_taken, notes, site_id,
                 lot_id, lot_code, resolution,
                 (photo IS NOT NULL) AS has_photo
          FROM qc_errors WHERE occurred_at >= ${since}
          ORDER BY id DESC LIMIT 25`;
        return res.status(200).json({
          days, since,
          total: total[0].n,
          by_worker: byWorker,
          by_stage: byStage,
          by_type: byType,
          by_product: byProduct,
          worker_stage: workerStage,
          recent,
        });
      }

      if (action === 'list') {
        if (!requireAdminPin(req, res)) return;
        const rows = await sql`
          SELECT id, created_at, occurred_at, order_number, customer, product, stage,
                 worker_code, error_type, caught_by, action_taken, notes, site_id,
                 lot_id, lot_code, resolution, resolution_note, resolved_at,
                 (photo IS NOT NULL) AS has_photo
          FROM qc_errors WHERE occurred_at >= ${since}
          ORDER BY id DESC LIMIT 100
        `;
        return res.status(200).json({ errors: rows, days });
      }

      if (action === 'export') {
        const rows = await sql`
          SELECT
            e.id, e.created_at, e.occurred_at, e.order_number, e.customer, e.product, e.stage,
            e.worker_code, COALESCE(w.name, e.worker_code) AS worker_name,
            e.error_type, e.caught_by, e.action_taken, e.notes, e.site_id,
            (e.photo IS NOT NULL) AS has_photo
          FROM qc_errors e
          LEFT JOIN workers w ON w.worker_id = e.worker_code
          WHERE e.occurred_at >= ${since}
          ORDER BY e.id DESC
        `;
        const header = [
          'ID', 'Logged at (UTC)', 'Date', 'Order #', 'Customer', 'Product', 'Stage',
          'Worker code', 'Worker name', 'Error type', 'Error description',
          'Caught by', 'Action taken', 'Notes', 'Site', 'Has photo',
        ];
        const errorDesc = { WC:'Wrong cut', WW:'Wrong weight', WQ:'Wrong qty', WP:'Wrong product', M:'Missing', O:'Other' };
        const siteName = { flemington: 'Flemington', brooklyn: 'Brooklyn' };
        const lines = [header.map(csvField).join(',')];
        for (const r of rows) {
          lines.push([
            r.id,
            r.created_at ? new Date(r.created_at).toISOString() : '',
            r.occurred_at ? new Date(r.occurred_at).toISOString().slice(0, 10) : '',
            r.order_number, r.customer, r.product, r.stage,
            r.worker_code, r.worker_name, r.error_type,
            errorDesc[r.error_type] || r.error_type,
            r.caught_by, r.action_taken, r.notes,
            siteName[r.site_id] || r.site_id || '',
            r.has_photo ? 'Y' : '',
          ].map(csvField).join(','));
        }
        const body = '﻿' + lines.join('\r\n') + '\r\n';
        const today = new Date().toISOString().slice(0, 10);
        const filename = `gtc-qc-errors-last${days}d-${today}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(body);
      }

      return res.status(400).json({ error: 'Unknown action. Use ?action=data | list | export.' });
    }

    // -----------------------------------------------------------------------
    // PATCH: edit one error by id (PIN). COALESCE means undefined leaves the
    // existing value alone. remove_photo=true nulls the photo column.
    // -----------------------------------------------------------------------
    if (req.method === 'PATCH') {
      if (!requireAdminPin(req, res)) return;
      const b = req.body || {};
      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const removePhoto = b.remove_photo === true;
      // Auto-stamp resolved_at when the resolution is moved into a closed state.
      const closedStates = ['credited', 'replaced', 'dismissed', 'closed'];
      const resolvedAtSet = b.resolution && closedStates.includes(b.resolution);
      await sql`UPDATE qc_errors SET
        occurred_at     = COALESCE(${b.occurred_at}, occurred_at),
        order_number    = COALESCE(${b.order_number}, order_number),
        customer        = COALESCE(${b.customer}, customer),
        product         = COALESCE(${b.product}, product),
        stage           = COALESCE(${b.stage}, stage),
        worker_code     = COALESCE(${b.worker_code}, worker_code),
        error_type      = COALESCE(${b.error_type}, error_type),
        caught_by       = COALESCE(${b.caught_by}, caught_by),
        action_taken    = COALESCE(${b.action_taken}, action_taken),
        notes           = COALESCE(${b.notes}, notes),
        site_id         = COALESCE(${b.site_id}, site_id),
        lot_id          = COALESCE(${b.lot_id || null}, lot_id),
        lot_code        = COALESCE(${b.lot_code}, lot_code),
        resolution      = COALESCE(${b.resolution}, resolution),
        resolution_note = COALESCE(${b.resolution_note}, resolution_note),
        resolved_at     = CASE WHEN ${resolvedAtSet} THEN NOW() ELSE resolved_at END,
        photo           = CASE WHEN ${removePhoto} THEN NULL ELSE photo END
        WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if (!requireAdminPin(req, res)) return;
      const id = parseInt((req.query && req.query.id) || (req.body && req.body.id) || '', 10);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const r = await sql`DELETE FROM qc_errors WHERE id = ${id} RETURNING id`;
      if (r.length === 0) return res.status(404).json({ error: 'Error not found' });
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', detail: String(e.message || e) });
  }
}

// =============================================================================
// APNs HTTP/2 push — token-based auth (no certs). Requires four env vars set
// in Vercel; if any is missing, sendAPNsToDevices silently no-ops and the
// system still works (cron + token storage just don't deliver pushes yet).
//
//   APNS_KEY_ID         — 10-char key id from Apple Developer Console
//   APNS_TEAM_ID        — 10-char Apple Developer team id
//   APNS_BUNDLE_ID      — com.gtchickens.receiving (or whatever Bundle ID ships)
//   APNS_PRIVATE_KEY    — full .p8 PEM. Vercel env vars require \n escapes;
//                         we restore real newlines before passing to crypto.
// =============================================================================

function apnsConfigured() {
  return Boolean(
    process.env.APNS_KEY_ID &&
    process.env.APNS_TEAM_ID &&
    process.env.APNS_BUNDLE_ID &&
    process.env.APNS_PRIVATE_KEY
  );
}

/// Sign an ES256 JWT for APNs. Cached up to 50 min (Apple wants < 1 hour).
let _apnsJwtCache = { value: null, expiresAt: 0 };
function apnsJwt() {
  const now = Math.floor(Date.now() / 1000);
  if (_apnsJwtCache.value && _apnsJwtCache.expiresAt > now + 60) return _apnsJwtCache.value;
  const header = { alg: 'ES256', kid: process.env.APNS_KEY_ID, typ: 'JWT' };
  const claims = { iss: process.env.APNS_TEAM_ID, iat: now };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const c = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const msg = `${h}.${c}`;
  const pem = String(process.env.APNS_PRIVATE_KEY).replace(/\\n/g, '\n');
  const sig = crypto.sign('sha256', Buffer.from(msg), { key: pem, dsaEncoding: 'ieee-p1363' });
  const jwt = `${msg}.${sig.toString('base64url')}`;
  _apnsJwtCache = { value: jwt, expiresAt: now + 50 * 60 };
  return jwt;
}

/// Send a single APNs alert via HTTP/2. Returns { ok, status, body }.
function sendAPNsOne(deviceToken, payload) {
  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    let client;
    try {
      client = http2.connect('https://api.push.apple.com');
    } catch (e) {
      return safeResolve({ ok: false, status: 0, body: 'connect failed: ' + e.message });
    }
    client.on('error', (e) => safeResolve({ ok: false, status: 0, body: 'h2 error: ' + e.message }));
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'apns-topic': process.env.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'authorization': `bearer ${apnsJwt()}`,
      'content-type': 'application/json',
    };
    const req = client.request(headers);
    let status = 0;
    let body = '';
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { client.close(); safeResolve({ ok: status >= 200 && status < 300, status, body }); });
    req.on('error', (e) => { try { client.close(); } catch {} ; safeResolve({ ok: false, status: 0, body: 'req error: ' + e.message }); });
    req.write(JSON.stringify(payload));
    req.end();
  });
}

/// Send an APNs alert to every device in `devices`. Disables tokens APNs reports
/// as unregistered/bad (so we stop trying to push to phones that uninstalled).
/// Returns the count successfully sent. No-ops if APNs env vars aren't set.
async function sendAPNsToDevices(devices, { title, body, badge = 1 }) {
  if (!apnsConfigured()) {
    console.warn('APNs not configured — skipping push to', devices.length, 'devices');
    return 0;
  }
  const payload = { aps: { alert: { title, body }, sound: 'default', badge } };
  let sent = 0;
  for (const d of devices) {
    const r = await sendAPNsOne(d.token, payload);
    if (r.ok) {
      sent++;
    } else if (r.status === 410 || r.status === 400) {
      // 410 Unregistered: app uninstalled / token revoked. Stop trying.
      try { await sql`UPDATE devices SET enabled = FALSE WHERE id = ${d.id}`; } catch {}
    } else {
      console.warn('APNs send failed', { device_id: d.id, status: r.status, body: r.body });
    }
  }
  return sent;
}
