// Receiving history — recent deliveries + batch search.
function updateNetStatus() {
  const pill = document.getElementById('netstatus');
  if (navigator.onLine) { pill.textContent = 'online'; pill.className = 'pill online'; }
  else { pill.textContent = 'offline'; pill.className = 'pill offline'; }
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' });
}
function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) + ' ' +
         dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}
function daysUntil(d) {
  if (!d) return null;
  const ms = new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0);
  return Math.round(ms / 86400000);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function load() {
  const days = document.getElementById('period').value;
  const q = document.getElementById('search').value.trim();
  const body = document.getElementById('receipts-body');
  body.innerHTML = '<tr><td colspan="8">Loading…</td></tr>';
  let receipts = [];
  try {
    const url = '/api/receipts?days=' + encodeURIComponent(days) + (q ? '&q=' + encodeURIComponent(q) : '');
    const r = await fetch(url);
    const data = await r.json();
    receipts = data.receipts || [];
  } catch (e) {
    body.innerHTML = '<tr><td colspan="8">Offline — connect to view history.</td></tr>';
    return;
  }
  renderKpis(receipts);
  renderRows(receipts);
}

function renderKpis(rows) {
  document.getElementById('kpi-count').textContent = rows.length;
  const totalWeight = rows.reduce((a, r) => a + (Number(r.weight_kg) || 0), 0);
  document.getElementById('kpi-weight').textContent = totalWeight ? totalWeight.toFixed(1) : '—';
  const suppliers = [...new Set(rows.map((r) => r.supplier).filter(Boolean))];
  document.getElementById('kpi-suppliers').textContent = suppliers.length || '—';
  const expiring = rows.filter((r) => { const d = daysUntil(r.use_by); return d !== null && d >= 0 && d <= 3; }).length;
  document.getElementById('kpi-expiring').textContent = expiring;
}

function renderRows(rows) {
  const body = document.getElementById('receipts-body');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8">No deliveries in this period.</td></tr>'; return; }
  body.innerHTML = '';
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const qty = r.quantity != null ? `${Number(r.quantity)} ${esc(r.unit || '')}` : '';
    const weight = r.weight_kg != null ? `${Number(r.weight_kg)} kg` : '';
    let useby = '';
    if (r.use_by) {
      const d = daysUntil(r.use_by);
      const cls = d !== null && d < 0 ? 'tag-expiry' : (d !== null && d <= 3 ? 'tag-soon' : '');
      useby = `<span class="${cls}">${fmtDate(r.use_by)}</span>`;
    }
    const photo = r.has_photo ? `<button class="photo-cell-btn" data-id="${r.id}">View</button>` : '';
    tr.innerHTML =
      `<td>${fmtDateTime(r.received_ts || r.received_on)}</td>` +
      `<td>${esc(r.product)}</td>` +
      `<td>${esc(r.supplier)}</td>` +
      `<td>${qty}</td>` +
      `<td>${weight}</td>` +
      `<td>${esc(r.batch_number)}</td>` +
      `<td>${useby}</td>` +
      `<td>${photo}</td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('.photo-cell-btn').forEach((b) => b.addEventListener('click', () => showPhoto(b.dataset.id)));
}

async function showPhoto(id) {
  try {
    const r = await fetch('/api/photo?id=' + encodeURIComponent(id));
    if (!r.ok) return;
    const { photo } = await r.json();
    document.getElementById('lightbox-img').src = photo;
    document.getElementById('lightbox').hidden = false;
  } catch (e) { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', () => {
  updateNetStatus();
  window.addEventListener('online', updateNetStatus);
  window.addEventListener('offline', updateNetStatus);

  document.getElementById('period').addEventListener('change', load);
  document.getElementById('searchbtn').addEventListener('click', load);
  document.getElementById('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  document.getElementById('lightbox-close').addEventListener('click', () => { document.getElementById('lightbox').hidden = true; });
  document.getElementById('lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') document.getElementById('lightbox').hidden = true; });

  load();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
