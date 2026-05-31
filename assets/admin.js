// Admin — PIN-gated management of suppliers, products, barcodes, receipts.
let PIN = sessionStorage.getItem('admin_pin') || '';

function updateNetStatus() {
  const pill = document.getElementById('netstatus');
  if (navigator.onLine) { pill.textContent = 'online'; pill.className = 'pill online'; }
  else { pill.textContent = 'offline'; pill.className = 'pill offline'; }
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtDate(d) { if (!d) return ''; return new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' }); }
function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) + ' ' +
         dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}
function adminMsg(kind, msg) {
  const el = document.getElementById('admin-result');
  el.className = 'result ' + kind; el.textContent = msg; el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

function authedFetch(url, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, { 'X-Admin-PIN': PIN });
  if (opts.body && !opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
  return fetch(url, opts);
}

async function unlock(pin) {
  const r = await fetch('/api/admin-check', { headers: { 'X-Admin-PIN': pin } });
  if (!r.ok) {
    document.getElementById('gate-result').className = 'result bad';
    document.getElementById('gate-result').textContent = 'Wrong PIN.';
    document.getElementById('gate-result').hidden = false;
    return;
  }
  PIN = pin;
  sessionStorage.setItem('admin_pin', pin);
  document.getElementById('gate').hidden = true;
  document.getElementById('adminarea').hidden = false;
  loadAll();
}

async function loadAll() {
  await Promise.all([loadSuppliers(), loadProducts(), loadBarcodes(), loadReceipts()]);
}

// ---------- Suppliers ----------
async function loadSuppliers() {
  const body = document.getElementById('sup-body');
  const r = await fetch('/api/suppliers');
  const { suppliers } = await r.json();
  body.innerHTML = '';
  suppliers.forEach((s) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${esc(s.name)}</td><td>${esc(s.code)}</td>` +
      `<td>${esc(s.status)}</td>` +
      `<td><button class="rowbtn" data-act="toggle">${s.status === 'Active' ? 'Deactivate' : 'Activate'}</button>` +
      `<button class="rowbtn rowbtn-danger" data-act="del">Delete</button></td>`;
    tr.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      await authedFetch('/api/suppliers', { method: 'PATCH', body: JSON.stringify({ id: s.id, status: s.status === 'Active' ? 'Inactive' : 'Active' }) });
      loadSuppliers();
    });
    tr.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`Delete supplier "${s.name}"?`)) return;
      await authedFetch('/api/suppliers?id=' + s.id, { method: 'DELETE' });
      loadSuppliers();
    });
    body.appendChild(tr);
  });
}

// ---------- Products ----------
async function loadProducts() {
  const body = document.getElementById('prod-body');
  const r = await fetch('/api/products');
  const { products } = await r.json();
  body.innerHTML = '';
  products.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${esc(p.canonical_name)}</td><td>${esc(p.aliases)}</td><td>${esc(p.unit)}</td>` +
      `<td><button class="rowbtn rowbtn-danger" data-act="del">Delete</button></td>`;
    tr.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`Delete product "${p.canonical_name}"? (Existing receipts keep the name.)`)) return;
      await authedFetch('/api/products?canonical_name=' + encodeURIComponent(p.canonical_name), { method: 'DELETE' });
      loadProducts();
    });
    body.appendChild(tr);
  });
}

// ---------- Barcodes ----------
async function loadBarcodes() {
  const body = document.getElementById('bc-body');
  const r = await authedFetch('/api/barcodes');
  if (!r.ok) { body.innerHTML = '<tr><td colspan="4">Could not load.</td></tr>'; return; }
  const { barcodes } = await r.json();
  body.innerHTML = '';
  if (!barcodes.length) { body.innerHTML = '<tr><td colspan="4">No mappings learned yet.</td></tr>'; return; }
  barcodes.forEach((b) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${esc(b.barcode)}</td><td>${esc(b.product)}</td><td>${esc(b.supplier)}</td>` +
      `<td><button class="rowbtn rowbtn-danger" data-act="del">Delete</button></td>`;
    tr.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`Delete mapping for barcode "${b.barcode}"?`)) return;
      await authedFetch('/api/barcodes?barcode=' + encodeURIComponent(b.barcode), { method: 'DELETE' });
      loadBarcodes();
    });
    body.appendChild(tr);
  });
}

// ---------- Receipts ----------
async function loadReceipts() {
  const body = document.getElementById('rec-body');
  const r = await fetch('/api/receipts?days=30');
  const { receipts } = await r.json();
  body.innerHTML = '';
  if (!receipts.length) { body.innerHTML = '<tr><td colspan="8">No receipts in the last 30 days.</td></tr>'; return; }
  receipts.forEach((rc) => {
    const tr = document.createElement('tr');
    const qty = rc.quantity != null ? `${Number(rc.quantity)} ${esc(rc.unit || '')}` : '';
    const weight = rc.weight_kg != null ? `${Number(rc.weight_kg)} kg` : '';
    tr.innerHTML =
      `<td>${fmtDateTime(rc.received_ts || rc.received_on)}</td>` +
      `<td>${esc(rc.product)}</td><td>${esc(rc.supplier)}</td>` +
      `<td>${qty}</td><td>${weight}</td><td>${esc(rc.batch_number)}</td><td>${fmtDate(rc.use_by)}</td>` +
      `<td><button class="rowbtn rowbtn-danger" data-act="del">Delete</button></td>`;
    tr.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm('Delete this receipt?')) return;
      const res = await authedFetch('/api/receipts?id=' + rc.id, { method: 'DELETE' });
      if (res.ok) { adminMsg('ok', 'Receipt deleted.'); loadReceipts(); }
      else adminMsg('bad', 'Delete failed.');
    });
    body.appendChild(tr);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  updateNetStatus();
  window.addEventListener('online', updateNetStatus);
  window.addEventListener('offline', updateNetStatus);

  document.getElementById('pinbtn').addEventListener('click', () => unlock(document.getElementById('pin').value.trim()));
  document.getElementById('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(e.target.value.trim()); });

  document.getElementById('exportbtn').addEventListener('click', () => {
    const days = document.getElementById('period').value;
    window.location.href = '/api/export?days=' + encodeURIComponent(days);
  });

  document.getElementById('sup-add').addEventListener('click', async () => {
    const name = document.getElementById('sup-name').value.trim();
    if (!name) return adminMsg('bad', 'Supplier name required.');
    const res = await authedFetch('/api/suppliers', { method: 'POST', body: JSON.stringify({ name, code: document.getElementById('sup-code').value.trim() || null }) });
    if (res.ok) { document.getElementById('sup-name').value = ''; document.getElementById('sup-code').value = ''; adminMsg('ok', 'Supplier saved.'); loadSuppliers(); }
    else adminMsg('bad', 'Save failed.');
  });

  document.getElementById('prod-add').addEventListener('click', async () => {
    const name = document.getElementById('prod-name').value.trim();
    if (!name) return adminMsg('bad', 'Product name required.');
    const res = await authedFetch('/api/products', { method: 'POST', body: JSON.stringify({
      canonical_name: name,
      aliases: document.getElementById('prod-aliases').value.trim() || null,
      unit: document.getElementById('prod-unit').value.trim() || null,
    }) });
    if (res.ok) { ['prod-name', 'prod-aliases', 'prod-unit'].forEach((id) => document.getElementById(id).value = ''); adminMsg('ok', 'Product saved.'); loadProducts(); }
    else adminMsg('bad', 'Save failed.');
  });

  document.getElementById('bc-add').addEventListener('click', async () => {
    const barcode = document.getElementById('bc-code').value.trim();
    const product = document.getElementById('bc-product').value.trim();
    if (!barcode || !product) return adminMsg('bad', 'Barcode and product required.');
    const res = await authedFetch('/api/barcodes', { method: 'POST', body: JSON.stringify({ barcode, product, supplier: document.getElementById('bc-supplier').value.trim() || null }) });
    if (res.ok) { ['bc-code', 'bc-product', 'bc-supplier'].forEach((id) => document.getElementById(id).value = ''); adminMsg('ok', 'Mapping saved.'); loadBarcodes(); }
    else adminMsg('bad', 'Save failed.');
  });

  if (PIN) unlock(PIN);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
