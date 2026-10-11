/**
 * tally-ui.js
 * Talks to Tally through the BoltYards GSTR browser extension:
 *   1. "Import from Tally" — pulls the purchase register for a date range
 *      and runs the reconciliation.
 *   2. "Send to Tally"     — books the invoices that are in GSTR-2B but not in
 *      the books as purchase vouchers (debit notes for credit notes).
 *
 * The page cannot call Tally (localhost:9000) itself: Tally sends no CORS
 * headers and this site is https. So requests go page -> extension content
 * script -> extension background -> Tally, and replies come back the same
 * way, as window.postMessage events. Nothing leaves the machine.
 *
 * Relies on globals from books-ui.js (booksRows, booksMeta, setBooks,
 * runBooksRecon, booksNotice, BooksRecon, esc, money, dmy, taxOf, section,
 * only2bCols) and app.js (files, MAX_FILES).
 */

const TALLY_CFG_KEY = 'gstr_tally_cfg_v1';
const MIN_EXT_VERSION = '1.6.0';
const PUSH_CHUNK = 20;                 // vouchers per request, so progress can be shown

const ext = { ready: false, version: '' };
const tallyOrigin = () => (location.origin === 'null' ? '*' : location.origin);

// ── Request / reply plumbing ────────────────────────────────────────────────

let tallyReqId = 0;
const tallyPending = new Map();

function versionAtLeast(have, need) {
  const a = String(have).split('.').map(Number), b = String(need).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
  return true;
}

function tallyRequest(op, payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = ++tallyReqId;
    const timer = setTimeout(() => {
      tallyPending.delete(id);
      reject(new Error(ext.ready
        ? 'Tally did not answer in time. Check that Tally is open and not showing a dialog.'
        : 'The GSTR extension did not respond. Install or update it (version ' + MIN_EXT_VERSION + ' or later) and refresh this page.'));
    }, timeoutMs);
    tallyPending.set(id, { resolve, reject, timer });
    window.postMessage({ type: 'GSTR_TALLY_REQUEST', id, op, payload }, tallyOrigin());
  });
}

window.addEventListener('message', e => {
  if (e.source !== window || !e.data) return;
  if (location.origin !== 'null' && e.origin !== location.origin) return;
  if (e.data.type === 'GSTR_EXT_PONG') {
    ext.ready = true; ext.version = e.data.version || '';
    renderExtStatus();
  } else if (e.data.type === 'GSTR_TALLY_RESPONSE') {
    const p = tallyPending.get(e.data.id);
    if (!p) return;
    tallyPending.delete(e.data.id);
    clearTimeout(p.timer);
    e.data.ok ? p.resolve(e.data.data) : p.reject(new Error(e.data.error || 'Tally request failed'));
  }
});

/** Resolve once the extension has answered a ping; fail fast if it never does. */
function ensureExtension() {
  if (ext.ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.postMessage({ type: 'GSTR_EXT_PING' }, tallyOrigin());
    const started = Date.now();
    (function wait() {
      if (ext.ready) return resolve();
      if (Date.now() - started > 1500) {
        return reject(new Error('The GSTR extension is not installed or not active on this page. Install it (version ' + MIN_EXT_VERSION + ' or later), then refresh this page.'));
      }
      setTimeout(wait, 100);
    })();
  });
}

function renderExtStatus() {
  const el = document.getElementById('ext-status');
  if (!el) return;
  if (!ext.ready) {
    el.className = 'ext-status warn';
    el.textContent = 'GSTR extension not detected. Importing from Tally needs the BoltYards GSTR downloader extension (v' + MIN_EXT_VERSION + '+) in this browser.';
  } else if (!versionAtLeast(ext.version, MIN_EXT_VERSION)) {
    el.className = 'ext-status warn';
    el.textContent = `GSTR extension v${ext.version} found — update it to v${MIN_EXT_VERSION} or later to talk to Tally from this page.`;
  } else {
    el.className = 'ext-status ok';
    el.textContent = `GSTR extension connected (v${ext.version}).`;
  }
}

// ── Import from Tally ───────────────────────────────────────────────────────

const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let rangeTouched = false;

function isoMonthOf(label) {                    // 'Apr-25' -> '2025-04'
  const m = CAL_MONTHS.indexOf(label.slice(0, 3));
  const y = parseInt(label.slice(-2), 10);
  return m < 0 || isNaN(y) ? '' : `${2000 + y}-${String(m + 1).padStart(2, '0')}`;
}

/** Default the range to the months of the GSTR-2B files loaded above. */
function syncTallyRange() {
  if (rangeTouched) return;
  const labels = Object.keys(files['2b'] || {});
  if (!labels.length) return;
  const iso = labels.map(isoMonthOf).filter(Boolean).sort();
  if (!iso.length) return;
  document.getElementById('tally-from').value = iso[0];
  document.getElementById('tally-to').value = iso[iso.length - 1];
}

function setDefaultRange() {
  const now = new Date();
  const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('tally-from').value = `${fyStartYear}-04`;
  document.getElementById('tally-to').value = `${now.getFullYear()}-${mm}`;
}

function twoBGstins() {
  return [...new Set(Object.values(files['2b'] || {}).map(f => {
    const d = f.data && (f.data.data || f.data);
    return String((d && d.gstin) || '').toUpperCase();
  }).filter(Boolean))];
}

async function importFromTally() {
  const btn = document.getElementById('btn-tally-import');
  const from = document.getElementById('tally-from').value;
  const to = document.getElementById('tally-to').value;
  document.getElementById('books-notices').innerHTML = '';
  if (!from || !to) return booksNotice('error', 'Choose the From and To months to import.');
  if (to < from) return booksNotice('error', 'The To month is before the From month.');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Reading Tally…';
  try {
    await ensureExtension();
    if (!versionAtLeast(ext.version, MIN_EXT_VERSION)) {
      throw new Error(`The GSTR extension (v${ext.version}) is too old — update to v${MIN_EXT_VERSION} or later.`);
    }
    const data = await tallyRequest('fetchBooks', { from, to }, 10 * 60 * 1000);
    const company = (data.companies || [])[0] || '';
    if (!data.rows.length) {
      booksNotice('warn', 'Tally returned no purchase entries with input GST for that period. Check the right company and dates are open in Tally.');
      return;
    }
    const meta = { company, companyGstins: data.companyGstins || [] };
    setBooks(data.rows, `Tally – ${company || 'open company'}`, meta);
    const mine = twoBGstins();
    if (mine.length && meta.companyGstins.length && !meta.companyGstins.some(g => mine.includes(g))) {
      booksNotice('warn', `Tally's open company (GSTIN ${meta.companyGstins.join(', ')}) does not match the GSTR-2B files (GSTIN ${mine.join(', ')}). Make sure the right company is open.`);
    }
    if (data.stats && data.stats.rcmOnly) {
      booksNotice('warn', `${data.stats.rcmOnly} reverse-charge entr${data.stats.rcmOnly === 1 ? 'y was' : 'ies were'} left out (no input credit in GSTR-2B).`);
    }
    if (Object.keys(files['2b']).length) runBooksRecon();
  } catch (err) {
    booksNotice('error', err.message);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

// ── Choosing invoices to send ───────────────────────────────────────────────

let pushRows = [];              // r.only2b of the current result
let pushSel = new Set();        // indexes into pushRows that are ticked
let pushSent = new Set();       // indexes already booked in Tally this session

/** Why an invoice can't be auto-booked ('' = it can). */
function pushBlocker(k) {
  if (k.reverseCharge) return 'Reverse charge — book manually';
  if (!k.itcAvailable) return 'ITC not available';
  if (!BooksRecon.isoDate(k.date)) return 'No invoice date';
  if (!String(k.no || '').trim()) return 'No invoice number';
  return '';
}

function only2bSectionHTML(r) {
  pushRows = r.only2b;
  pushSel = new Set();
  pushSent = new Set();
  if (!pushRows.length) return '';
  const canSend = !!booksMeta.company;
  const body = pushRows.map((k, i) => {
    const why = pushBlocker(k);
    return `<tr data-i="${i}">
      <td class="tp-pick"><input type="checkbox" class="tp-row" data-i="${i}" ${why ? 'disabled' : ''} aria-label="Select ${esc(k.no)}"></td>
      <td>${esc(k.party)}</td><td>${esc(k.ctin)}</td><td>${esc(k.no)}</td><td>${esc(dmy(k.date))}</td>
      <td class="num">${money(k.taxable)}</td><td class="num">${money(taxOf(k))}</td>
      <td class="tp-state">${esc(why || (k.kind === 'CN' ? 'Credit note → Debit Note' : ''))}</td>
    </tr>`;
  }).join('');
  return `<details class="table-wrap bk-details" open>
    <summary>In GSTR-2B, not in books<span class="bk-badge bad">${pushRows.length}</span></summary>
    <p class="bk-note" style="padding:0 14px">The supplier reported these but they are not in your purchase register. ITC can usually only be claimed once they are booked. Tick the invoices to book in Tally.</p>
    <div class="tp-bar">
      <label class="tp-all"><input type="checkbox" id="tp-all"> Select all that can be sent</label>
      <span class="run-hint" id="tp-count"></span>
      <button type="button" class="btn-run" id="btn-tally-push" disabled
        title="${canSend ? '' : 'Import the register from Tally first, so we know which company to post into.'}">Send selected to Tally…</button>
    </div>
    <div style="overflow-x:auto"><table class="bk-table"><thead><tr>
      <th></th><th>Supplier</th><th>GSTIN</th><th>Invoice</th><th>Date</th><th class="num">Taxable</th><th class="num">Tax</th><th>Note</th>
    </tr></thead><tbody>${body}</tbody></table></div>
    <div id="tally-push-panel"></div>
  </details>`;
}

function refreshPickState() {
  const eligible = pushRows.map((k, i) => i).filter(i => !pushBlocker(pushRows[i]) && !pushSent.has(i));
  const all = document.getElementById('tp-all');
  const count = document.getElementById('tp-count');
  const btn = document.getElementById('btn-tally-push');
  if (!all) return;
  all.checked = eligible.length > 0 && eligible.every(i => pushSel.has(i));
  all.disabled = !eligible.length;
  count.textContent = pushSel.size ? `${pushSel.size} selected` : (eligible.length ? '' : 'Nothing here can be sent automatically.');
  btn.disabled = !(pushSel.size && booksMeta.company);
  document.querySelectorAll('.tp-row').forEach(cb => {
    const i = +cb.dataset.i;
    cb.checked = pushSel.has(i);
    if (pushSent.has(i)) {
      cb.disabled = true; cb.checked = false;
      const st = cb.closest('tr').querySelector('.tp-state');
      st.textContent = 'Sent to Tally ✓'; st.className = 'tp-state sent';
    }
  });
}

function bindOnly2b() {
  const table = document.getElementById('btn-tally-push');
  if (!table) return;
  document.querySelectorAll('.tp-row').forEach(cb => cb.addEventListener('change', () => {
    cb.checked ? pushSel.add(+cb.dataset.i) : pushSel.delete(+cb.dataset.i);
    refreshPickState();
  }));
  document.getElementById('tp-all').addEventListener('change', e => {
    pushRows.forEach((k, i) => {
      if (pushBlocker(k) || pushSent.has(i)) return;
      e.target.checked ? pushSel.add(i) : pushSel.delete(i);
    });
    refreshPickState();
  });
  table.addEventListener('click', openPushPanel);
  refreshPickState();
}

// ── Posting settings (remembered) ───────────────────────────────────────────

const CFG_FIELDS = [
  ['voucherType',   'Purchase voucher type', 'Purchase'],
  ['purchaseLedger','Purchase ledger', ''],
  ['cgst',          'Input CGST ledger', ''],
  ['sgst',          'Input SGST ledger', ''],
  ['igst',          'Input IGST ledger', ''],
  ['cess',          'Input Cess ledger (if any cess)', ''],
  ['debitNoteType', 'Debit note voucher type (for credit notes)', 'Debit Note'],
  ['returnLedger',  'Purchase return ledger (blank = purchase ledger)', ''],
];

function loadCfg() {
  try { return JSON.parse(localStorage.getItem(TALLY_CFG_KEY)) || {}; } catch (e) { return {}; }
}
function saveCfg(c) {
  try { localStorage.setItem(TALLY_CFG_KEY, JSON.stringify(c)); } catch (e) { /* private mode — just don't remember */ }
}

function readCfgForm() {
  const c = {};
  CFG_FIELDS.forEach(([k, , def]) => {
    const v = (document.getElementById('tcfg-' + k).value || '').trim();
    c[k] = v || def;
  });
  return {
    voucherType: c.voucherType, debitNoteType: c.debitNoteType,
    purchaseLedger: c.purchaseLedger, returnLedger: c.returnLedger,
    taxLedgers: { cgst: c.cgst, sgst: c.sgst, igst: c.igst, cess: c.cess },
    _flat: c,
  };
}

/** Pre-fill empty ledger fields from the ledgers actually in Tally. */
function suggestLedgers(ledgers) {
  const find = re => (ledgers.find(l => re.test(l.name)) || {}).name || '';
  return {
    purchaseLedger: (ledgers.find(l => /purchase/i.test(l.parent) && !/return/i.test(l.name)) || ledgers.find(l => /^purchase/i.test(l.name) && !/return/i.test(l.name)) || {}).name || '',
    cgst: find(/input.*cgst|cgst.*input/i), sgst: find(/input.*(sgst|utgst)|(sgst|utgst).*input/i),
    igst: find(/input.*igst|igst.*input/i), cess: find(/input.*cess|cess.*input/i),
    returnLedger: find(/purchase.*return|return.*purchase/i),
  };
}

// ── The push panel: settings → preview → confirm → results ─────────────────

function selectedVouchers() {
  return [...pushSel].sort((a, b) => a - b).map(i => {
    const k = pushRows[i];
    return {
      _row: i, date: BooksRecon.isoDate(k.date), invoiceNo: k.no, party: k.party, gstin: k.ctin, pos: k.pos,
      taxable: k.taxable, igst: k.igst, cgst: k.cgst, sgst: k.sgst, cess: k.cess, kind: k.kind,
    };
  });
}

function wireVoucher(v) { const { _row, ...rest } = v; return rest; }

async function openPushPanel() {
  const panel = document.getElementById('tally-push-panel');
  panel.innerHTML = '<div class="tp-panel"><p class="bk-note">Reading ledgers from Tally…</p></div>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const vouchers = selectedVouchers();
    // First pass only to learn which ledgers exist, so settings can be suggested.
    const first = await tallyRequest('plan', { vouchers: vouchers.map(wireVoucher), config: readStoredCfgForPlan() }, 60000);
    renderPushPanel(first.ledgers || []);
    await refreshPreview();
  } catch (err) {
    panel.innerHTML = `<div class="tp-panel"><div class="notice notice-error"><span>${esc(err.message)}</span></div></div>`;
  }
}

function readStoredCfgForPlan() {
  const c = loadCfg();
  return {
    voucherType: c.voucherType || 'Purchase', debitNoteType: c.debitNoteType || 'Debit Note',
    purchaseLedger: c.purchaseLedger || '', returnLedger: c.returnLedger || '',
    taxLedgers: { cgst: c.cgst || '', sgst: c.sgst || '', igst: c.igst || '', cess: c.cess || '' },
  };
}

let knownLedgers = [];

function renderPushPanel(ledgers) {
  knownLedgers = ledgers;
  const stored = loadCfg();
  const sug = suggestLedgers(ledgers);
  const suggested = [];
  const val = (k, def) => {
    if (stored[k]) return stored[k];
    if (sug[k]) { suggested.push(k); return sug[k]; }
    return def;
  };
  const options = ledgers.map(l => `<option value="${esc(l.name)}">${esc(l.parent)}</option>`).join('');
  const fields = CFG_FIELDS.map(([k, label, def]) => `
    <label class="tp-field"><span>${esc(label)}</span>
      <input type="text" id="tcfg-${k}" list="tally-ledgers" value="${esc(val(k, def))}" autocomplete="off"></label>`).join('');
  document.getElementById('tally-push-panel').innerHTML = `
    <div class="tp-panel">
      <h4>Send to Tally</h4>
      <p class="bk-note">Posting into <b>${esc(booksMeta.company)}</b>. Vouchers are created in Tally exactly as previewed below — nothing is written until you confirm.</p>
      <datalist id="tally-ledgers">${options}</datalist>
      <div class="tp-fields">${fields}</div>
      ${suggested.length ? '<p class="bk-note">Some ledgers were suggested from your Tally ledger list — please check them. They are remembered in this browser.</p>' : ''}
      <div class="tp-actions"><button type="button" class="btn-reset" id="btn-tally-preview">Refresh preview</button></div>
      <div id="tally-preview"></div>
    </div>`;
  document.getElementById('btn-tally-preview').addEventListener('click', refreshPreview);
}

async function refreshPreview() {
  const box = document.getElementById('tally-preview');
  const cfg = readCfgForm();
  saveCfg(cfg._flat);
  box.innerHTML = '<p class="bk-note">Checking against Tally…</p>';
  const vouchers = selectedVouchers();
  try {
    const plan = await tallyRequest('plan', { vouchers: vouchers.map(wireVoucher), config: cfg }, 60000);
    const newCount = new Set(plan.items.filter(p => p.isNew).map(p => p.partyLedger)).size;
    const rows = vouchers.map((v, i) => {
      const p = plan.items[i];
      return `<tr><td>${esc(p.partyLedger)}${p.isNew ? '<span class="bk-badge warn">new ledger</span>' : ''}</td>
        <td>${esc(v.gstin)}</td><td>${esc(v.invoiceNo)}</td><td>${esc(dmy(BooksRecon.parseDate(v.date)))}</td>
        <td class="num">${money(v.taxable)}</td><td class="num">${money(v.igst + v.cgst + v.sgst + v.cess)}</td>
        <td class="num">${money(v.taxable + v.igst + v.cgst + v.sgst + v.cess)}</td>
        <td>${v.kind === 'CN' ? esc(cfg.debitNoteType) : esc(cfg.voucherType)}</td></tr>`;
    }).join('');
    const problems = [];
    if (plan.missing.length) problems.push(`These ledgers are not in Tally — pick existing ones above: ${plan.missing.map(m => m || '(blank)').join(', ')}`);
    box.innerHTML = `
      <div class="summary-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="summary-card"><div class="sc-label">Vouchers to create</div><div class="sc-value">${vouchers.length}</div><div class="sc-sub">${esc(booksMeta.company)}</div></div>
        <div class="summary-card"><div class="sc-label">New supplier ledgers</div><div class="sc-value ${newCount ? 'mismatch' : 'match'}">${newCount}</div><div class="sc-sub">created under Sundry Creditors</div></div>
        <div class="summary-card"><div class="sc-label">Input tax booked</div><div class="sc-value">₹${money(vouchers.reduce((s, v) => s + (v.kind === 'CN' ? -1 : 1) * (v.igst + v.cgst + v.sgst + v.cess), 0))}</div><div class="sc-sub">net of debit notes</div></div>
      </div>
      ${problems.map(t => `<div class="notice notice-error" style="margin-bottom:10px"><span>${esc(t)}</span></div>`).join('')}
      <div style="overflow-x:auto"><table class="bk-table"><thead><tr>
        <th>Supplier ledger</th><th>GSTIN</th><th>Invoice (reference)</th><th>Date</th><th class="num">Taxable</th><th class="num">Tax</th><th class="num">Total</th><th>Voucher</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <div class="tp-actions">
        <button type="button" class="btn-run" id="btn-tally-confirm" ${problems.length ? 'disabled' : ''}>Create ${vouchers.length} voucher${vouchers.length === 1 ? '' : 's'} in Tally</button>
        <span class="run-hint">Check the first voucher in Tally (GST classification comes from your purchase ledger's settings).</span>
      </div>
      <div id="tally-result"></div>`;
    const confirm = document.getElementById('btn-tally-confirm');
    if (confirm) confirm.addEventListener('click', () => confirmPush(vouchers, cfg));
  } catch (err) {
    box.innerHTML = `<div class="notice notice-error"><span>${esc(err.message)}</span></div>`;
  }
}

async function confirmPush(vouchers, cfg) {
  const btn = document.getElementById('btn-tally-confirm');
  const out = document.getElementById('tally-result');
  btn.disabled = true;
  document.getElementById('btn-tally-preview').disabled = true;
  const results = [];
  try {
    for (let at = 0; at < vouchers.length; at += PUSH_CHUNK) {
      const chunk = vouchers.slice(at, at + PUSH_CHUNK);
      btn.textContent = `Sending… ${at}/${vouchers.length}`;
      const resp = await tallyRequest('push', {
        company: booksMeta.company, config: cfg, createSuppliers: true,
        vouchers: chunk.map(wireVoucher),
      }, 10 * 60 * 1000);
      resp.results.forEach((r, j) => results.push({ ...r, _row: chunk[j]._row }));
    }
  } catch (err) {
    out.innerHTML = `<div class="notice notice-error"><span>Stopped after ${results.length} of ${vouchers.length}: ${esc(err.message)}</span></div>`;
  }

  results.filter(r => r.ok).forEach(r => { pushSent.add(r._row); pushSel.delete(r._row); });
  refreshPickState();
  const ok = results.filter(r => r.ok), bad = results.filter(r => !r.ok);
  const made = results.filter(r => r.ledgerCreated).length;
  btn.textContent = 'Done';
  out.insertAdjacentHTML('afterbegin', `
    <div class="notice ${bad.length ? 'notice-warn' : 'notice-ok'}" style="margin:12px 0"><span>
      ${ok.length} voucher${ok.length === 1 ? '' : 's'} created in Tally${made ? `, ${made} new supplier ledger${made === 1 ? '' : 's'}` : ''}${bad.length ? `, ${bad.length} failed` : ''}.
    </span></div>
    ${bad.length ? `<div style="overflow-x:auto"><table class="bk-table"><thead><tr><th>Invoice</th><th>Supplier</th><th>Problem</th></tr></thead><tbody>${
      bad.map(r => `<tr><td>${esc(r.invoiceNo)}</td><td>${esc(r.party)}</td><td>${esc(r.error)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${ok.length ? '<div class="tp-actions"><button type="button" class="btn-run" id="btn-tally-reimport">Re-import from Tally and reconcile again</button></div>' : ''}`);
  const re = document.getElementById('btn-tally-reimport');
  if (re) re.addEventListener('click', importFromTally);
}

// ── Wiring ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setDefaultRange();
  ['tally-from', 'tally-to'].forEach(id =>
    document.getElementById(id).addEventListener('input', () => { rangeTouched = true; }));
  document.getElementById('btn-tally-import').addEventListener('click', importFromTally);
  window.postMessage({ type: 'GSTR_EXT_PING' }, tallyOrigin());
  setTimeout(renderExtStatus, 1500);       // if no PONG by now, say so
});

// Keep the range in step with the 2B files loaded above (until the user edits it).
(function () {
  const original = refreshBooksControls;
  refreshBooksControls = function () {
    original();
    if (document.getElementById('tally-from')) syncTallyRange();
  };
})();
