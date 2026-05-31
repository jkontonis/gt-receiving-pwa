// Goods-in receive page — barcode scan + offline queue + submission.
const DB_NAME = 'gt-receiving';
const DB_STORE = 'queue';

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE, { keyPath: 'client_id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function queueAdd(item) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(item);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function queueAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function queueRemove(client_id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(client_id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now();
}

// ---------- Photo: client-side resize so we don't blow up the DB ----------
function fileToResizedDataURL(file, maxDim = 1024, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Image decode failed'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function clearPhoto() {
  const input = document.getElementById('photofile');
  const preview = document.getElementById('photo-preview');
  const thumb = document.getElementById('photo-thumb');
  const hidden = document.getElementById('photo_data');
  const label = document.getElementById('photobtn-label');
  if (input) input.value = '';
  if (hidden) hidden.value = '';
  if (thumb) thumb.src = '';
  if (preview) preview.hidden = true;
  if (label) label.querySelector('.photobtn-text').textContent = 'Take / choose photo';
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function formatStamp(d) {
  const opts = { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' };
  const date = d.toLocaleDateString(undefined, opts);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return date + ' · ' + time;
}
function tickAutoTime() {
  const el = document.getElementById('autotime');
  if (el) el.textContent = formatStamp(new Date());
}

// ---------- Suppliers + products ----------
async function loadSuppliers() {
  const sel = document.getElementById('supplier');
  try {
    const r = await fetch('/api/suppliers');
    if (!r.ok) throw new Error('suppliers fetch failed');
    const { suppliers } = await r.json();
    const active = suppliers.filter((s) => s.status === 'Active');
    fillSupplierSelect(sel, active);
    localStorage.setItem('suppliers_cache', JSON.stringify(suppliers));
  } catch (e) {
    const cached = JSON.parse(localStorage.getItem('suppliers_cache') || '[]');
    fillSupplierSelect(sel, cached.filter((s) => s.status === 'Active'));
  }
}
function fillSupplierSelect(sel, list) {
  const current = sel.value;
  sel.innerHTML = '<option value="">— select supplier —</option>';
  list.forEach((s) => {
    const o = document.createElement('option');
    o.value = s.name; o.textContent = s.name;
    sel.appendChild(o);
  });
  if (current) sel.value = current;
}

let _productsList = [];
async function loadProducts() {
  const dl = document.getElementById('products');
  try {
    const r = await fetch('/api/products');
    if (!r.ok) throw new Error('products fetch failed');
    const { products } = await r.json();
    _productsList = products;
    dl.innerHTML = '';
    products.forEach((p) => { const o = document.createElement('option'); o.value = p.canonical_name; dl.appendChild(o); });
    localStorage.setItem('products_cache', JSON.stringify(products));
  } catch (e) {
    const cached = JSON.parse(localStorage.getItem('products_cache') || '[]');
    _productsList = cached;
    dl.innerHTML = '';
    cached.forEach((p) => { const o = document.createElement('option'); o.value = p.canonical_name; dl.appendChild(o); });
  }
}

function resolveKnownProduct(typed) {
  const norm = (typed || '').trim().toLowerCase();
  if (!norm) return null;
  for (const p of _productsList) {
    if ((p.canonical_name || '').toLowerCase() === norm) return p.canonical_name;
    const aliases = (p.aliases || '').split(';').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (aliases.includes(norm)) return p.canonical_name;
  }
  return null;
}

// ---------- Barcode -> product lookup ----------
// Local cache so a re-scan auto-fills even offline. Persisted as we learn them.
function cacheBarcode(map) {
  if (!map || !map.barcode) return;
  const store = JSON.parse(localStorage.getItem('barcode_cache') || '{}');
  store[map.barcode] = { product: map.product, supplier: map.supplier || null, unit: map.unit || null };
  localStorage.setItem('barcode_cache', JSON.stringify(store));
}
function cachedBarcode(barcode) {
  const store = JSON.parse(localStorage.getItem('barcode_cache') || '{}');
  return store[barcode] || null;
}

function applyMapping(m) {
  if (!m) return;
  if (m.product) document.getElementById('product').value = m.product;
  if (m.supplier) {
    const sel = document.getElementById('supplier');
    if ([...sel.options].some((o) => o.value === m.supplier)) sel.value = m.supplier;
  }
  if (m.unit) {
    const u = document.getElementById('unit');
    if ([...u.options].some((o) => o.value === m.unit)) u.value = m.unit;
  }
}

async function onBarcode(barcode) {
  const code = (barcode || '').trim();
  if (!code) return;
  document.getElementById('barcode').value = code;
  const hint = document.getElementById('scanhint');
  // Offline / cached first for instant fill
  const local = cachedBarcode(code);
  if (local) { applyMapping({ ...local, barcode: code }); hint.textContent = `Barcode ${code} → ${local.product}`; }
  if (!navigator.onLine) {
    if (!local) hint.textContent = `Barcode ${code} captured (offline — pick the product).`;
    document.getElementById('product').focus();
    return;
  }
  try {
    const r = await fetch('/api/lookup?barcode=' + encodeURIComponent(code));
    const data = await r.json();
    if (data.found) {
      applyMapping(data);
      cacheBarcode(data);
      hint.textContent = `Barcode ${code} → ${data.product}`;
    } else {
      hint.textContent = `New barcode ${code} — pick the product; it'll be remembered.`;
      document.getElementById('product').focus();
    }
  } catch (e) {
    if (!local) { hint.textContent = `Barcode ${code} captured — pick the product.`; document.getElementById('product').focus(); }
  }
}

// ---------- Camera scanning (BarcodeDetector) ----------
let _stream = null;
let _scanning = false;
let _detector = null;

async function startScan() {
  const video = document.getElementById('scan-video');
  const overlay = document.getElementById('scan-overlay');
  const hint = document.getElementById('scanhint');
  if (!('BarcodeDetector' in window)) {
    hint.textContent = 'This device/browser has no built-in scanner. Use a handheld scanner or type the barcode.';
    document.getElementById('barcode').focus();
    return;
  }
  try {
    const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];
    let supported = formats;
    try {
      const avail = await BarcodeDetector.getSupportedFormats();
      supported = formats.filter((f) => avail.includes(f));
      if (!supported.length) supported = avail;
    } catch (_) { /* use defaults */ }
    _detector = new BarcodeDetector({ formats: supported });
    _stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = _stream;
    video.hidden = false; overlay.hidden = false;
    await video.play();
    document.getElementById('scanbtn').hidden = true;
    document.getElementById('scanstop').hidden = false;
    _scanning = true;
    hint.textContent = 'Scanning… hold the barcode steady in the box.';
    scanLoop();
  } catch (e) {
    hint.textContent = 'Camera unavailable (' + (e && e.name || 'error') + '). Use a handheld scanner or type the barcode.';
    stopScan();
  }
}

async function scanLoop() {
  const video = document.getElementById('scan-video');
  if (!_scanning) return;
  try {
    const codes = await _detector.detect(video);
    if (codes && codes.length) {
      const value = codes[0].rawValue;
      if (value) {
        if (navigator.vibrate) navigator.vibrate(80);
        stopScan();
        onBarcode(value);
        return;
      }
    }
  } catch (_) { /* transient decode error — keep going */ }
  requestAnimationFrame(scanLoop);
}

function stopScan() {
  _scanning = false;
  const video = document.getElementById('scan-video');
  const overlay = document.getElementById('scan-overlay');
  if (_stream) { _stream.getTracks().forEach((t) => t.stop()); _stream = null; }
  if (video) { video.srcObject = null; video.hidden = true; }
  if (overlay) overlay.hidden = true;
  const sb = document.getElementById('scanbtn');
  const ss = document.getElementById('scanstop');
  if (sb) sb.hidden = false;
  if (ss) ss.hidden = true;
}

// ---------- Offline queue sync ----------
async function syncQueue() {
  const items = await queueAll();
  const pending = document.getElementById('pending');
  if (!items.length) { pending.hidden = true; return; }
  pending.hidden = false; pending.textContent = items.length + ' queued';
  if (!navigator.onLine) return;
  for (const item of items) {
    try {
      const r = await fetch('/api/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
      if (r.ok) await queueRemove(item.client_id);
    } catch (e) { /* keep queued */ }
  }
  const after = await queueAll();
  pending.hidden = after.length === 0;
  pending.textContent = after.length + ' queued';
}

function showResult(kind, msg) {
  const el = document.getElementById('result');
  el.className = 'result ' + kind;
  el.textContent = msg;
  el.hidden = false;
}
function updateNetStatus() {
  const pill = document.getElementById('netstatus');
  if (navigator.onLine) { pill.textContent = 'online'; pill.className = 'pill online'; }
  else { pill.textContent = 'offline'; pill.className = 'pill offline'; }
}

document.addEventListener('DOMContentLoaded', async () => {
  tickAutoTime();
  setInterval(tickAutoTime, 1000);

  updateNetStatus();
  window.addEventListener('online', () => { updateNetStatus(); syncQueue(); });
  window.addEventListener('offline', updateNetStatus);

  document.getElementById('scanbtn').addEventListener('click', startScan);
  document.getElementById('scanstop').addEventListener('click', stopScan);

  // Handheld scanner / manual entry: fires onBarcode on Enter or blur.
  const barcodeInput = document.getElementById('barcode');
  barcodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onBarcode(barcodeInput.value); } });
  barcodeInput.addEventListener('change', () => onBarcode(barcodeInput.value));

  await Promise.all([loadSuppliers(), loadProducts()]);
  await syncQueue();

  // Photo wiring
  const photoInput = document.getElementById('photofile');
  const photoLabel = document.getElementById('photobtn-label');
  const photoPreview = document.getElementById('photo-preview');
  const photoThumb = document.getElementById('photo-thumb');
  const photoHidden = document.getElementById('photo_data');
  const photoRemove = document.getElementById('photo-remove');
  if (photoInput) {
    photoInput.addEventListener('change', async () => {
      const file = photoInput.files && photoInput.files[0];
      if (!file) return;
      try {
        photoLabel.querySelector('.photobtn-text').textContent = 'Processing…';
        const dataUrl = await fileToResizedDataURL(file, 1024, 0.72);
        photoHidden.value = dataUrl;
        photoThumb.src = dataUrl;
        photoPreview.hidden = false;
        const kb = Math.round(dataUrl.length / 1024);
        photoLabel.querySelector('.photobtn-text').textContent = 'Replace photo (' + kb + ' KB)';
      } catch (e) {
        photoLabel.querySelector('.photobtn-text').textContent = 'Take / choose photo';
        showResult('bad', 'Photo failed to load — try again.');
      }
    });
  }
  if (photoRemove) photoRemove.addEventListener('click', clearPhoto);

  const form = document.getElementById('receiveform');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const now = new Date();
    const qtyVal = document.getElementById('quantity').value;
    const weightVal = document.getElementById('weight_kg').value;

    const payload = {
      client_id: uuid(),
      received_on: todayISO(),
      received_ts: now.toISOString(),
      barcode: document.getElementById('barcode').value.trim() || null,
      supplier: document.getElementById('supplier').value || null,
      product: document.getElementById('product').value.trim(),
      quantity: qtyVal === '' ? null : Number(qtyVal),
      unit: document.getElementById('unit').value || null,
      weight_kg: weightVal === '' ? null : Number(weightVal),
      batch_number: document.getElementById('batch_number').value.trim() || null,
      use_by: document.getElementById('use_by').value || null,
      notes: document.getElementById('notes').value.trim() || null,
      photo: document.getElementById('photo_data').value || null,
    };

    if (!payload.product) { showResult('bad', 'Pick or type the product.'); document.getElementById('product').focus(); return; }
    if (!payload.supplier) { showResult('bad', 'Choose the supplier.'); document.getElementById('supplier').focus(); return; }
    if (payload.quantity === null && payload.weight_kg === null) {
      showResult('bad', 'Enter a quantity or a weight.'); document.getElementById('quantity').focus(); return;
    }

    // Normalise product to a known canonical name if it matches one.
    const matched = resolveKnownProduct(payload.product);
    if (matched) payload.product = matched;

    // Remember the barcode mapping locally for instant offline re-scan.
    if (payload.barcode) cacheBarcode({ barcode: payload.barcode, product: payload.product, supplier: payload.supplier, unit: payload.unit });

    const btn = document.getElementById('submitbtn');
    btn.disabled = true; btn.textContent = 'SAVING…';

    if (!navigator.onLine) {
      await queueAdd(payload);
      showResult('queued', 'Saved offline at ' + formatStamp(now) + '. Will sync when online.');
      resetAfter();
      btn.disabled = false; btn.textContent = 'RECEIVE IN';
      await syncQueue();
      return;
    }
    try {
      const r = await fetch('/api/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (r.ok) {
        showResult('ok', 'Received in at ' + formatStamp(now) + ' — ' + payload.product + '. Thank you.');
        resetAfter();
        loadProducts();
      } else {
        const data = await r.json().catch(() => ({}));
        if (r.status >= 400 && r.status < 500 && data.error) {
          showResult('bad', data.error);
        } else {
          await queueAdd(payload);
          showResult('queued', 'Server error. Saved offline at ' + formatStamp(now) + ' — will retry.');
        }
      }
    } catch (e) {
      await queueAdd(payload);
      showResult('queued', 'No connection. Saved offline at ' + formatStamp(now) + '.');
    }
    btn.disabled = false; btn.textContent = 'RECEIVE IN';
    await syncQueue();
  });
});

function resetAfter() {
  ['barcode', 'product', 'quantity', 'weight_kg', 'batch_number', 'use_by', 'notes'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('supplier').value = '';
  document.getElementById('unit').value = 'carton';
  document.getElementById('scanhint').textContent = 'Point the tablet camera at the barcode. A handheld USB/Bluetooth scanner also works — it types into the box above.';
  clearPhoto();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
