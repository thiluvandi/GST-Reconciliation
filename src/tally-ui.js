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
const MIN_EXT_VERSION = '1.11.0';
const CREATE_LEDGERS_VERSION = '1.12.0';   // extension can create missing ledgers and post against a chosen supplier ledger
const canCreateLedgers = () => versionAtLeast(ext.version, CREATE_LEDGERS_VERSION);
const NEW_LEDGER_GROUPS = ['Purchase Accounts', 'Indirect Expenses', 'Direct Expenses', 'Fixed Assets'];
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
    const meta = { company, companyGstins: data.companyGstins || [] };
    setBooks(data.rows, `Tally – ${company || 'open company'}`, meta);
    const mine = twoBGstins();
    if (!data.rows.length) {
      // An empty register is a valid starting point: every 2B invoice is then
      // "in 2B, not in books" and can be booked from the list below.
      booksNotice('info', `Tally has no purchase entries with input GST for ${from} to ${to}${company ? ' in ' + company : ''}, so every GSTR-2B invoice is shown as missing from your books. If you expected entries, check the right company and dates are open in Tally.`);
      if (mine.length) booksNotice('warn', `With no entries Tally gives no GSTIN to check, so make sure the open company${company ? ' (' + company + ')' : ''} is the one for GSTIN ${mine.join(', ')} before booking anything into it.`);
    } else if (mine.length && meta.companyGstins.length && !meta.companyGstins.some(g => mine.includes(g))) {
      booksNotice('warn', `Tally's open company (GSTIN ${meta.companyGstins.join(', ')}) does not match the GSTR-2B files (GSTIN ${mine.join(', ')}). Make sure the right company is open.`);
    }
    if (data.stats && data.stats.rcmOnly) {
      booksNotice('warn', `${data.stats.rcmOnly} reverse-charge entr${data.stats.rcmOnly === 1 ? 'y was' : 'ies were'} left out (no input credit in GSTR-2B).`);
    }
    if (Object.keys(files['2b']).length) runBooksRecon({ keepNotices: true });
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
let pushSplit = {};             // index -> per-rate lines chosen for a mixed-rate invoice

const fmtRate = r => String(Math.round(Number(r) * 1000) / 1000);

/** Why an invoice can't be auto-booked ('' = it can). */
function pushBlocker(k, i) {
  if (k.reverseCharge) return 'Reverse charge — book manually';
  if (!k.itcAvailable) return 'ITC not available';
  if (!BooksRecon.isoDate(k.date)) return 'No invoice date';
  if (!String(k.no || '').trim()) return 'No invoice number';
  if (k._rate === null && !pushSplit[i]) return 'Mixed rate — split it, or book manually';
  return '';
}

function rateText(i) {
  const k = pushRows[i];
  if (pushSplit[i]) return pushSplit[i].map(l => fmtRate(l.rate) + '%').join(' + ');
  return k._rate === null ? 'Mixed' : fmtRate(k._rate) + '%';
}

function rateCellHTML(i) {
  const k = pushRows[i];
  const canSplit = k._rate === null && !k.reverseCharge && k.itcAvailable;
  const split = pushSplit[i];
  return esc(rateText(i)) + (canSplit || split
    ? ` <button type="button" class="tp-link tp-split-btn" data-i="${i}">${split ? 'Edit' : 'Split'}</button>` : '');
}

function only2bSectionHTML(r) {
  pushRows = r.only2b;
  pushSel = new Set();
  pushSent = new Set();
  pushSplit = {};
  lineOverrides = {};
  partyOverrides = {};
  pushRows.forEach(k => { k._rate = BooksRecon.impliedRate(k.taxable, k.igst + k.cgst + k.sgst); });
  if (!pushRows.length) return '';
  const canSend = !!booksMeta.company;
  const body = pushRows.map((k, i) => {
    const why = pushBlocker(k, i);
    return `<tr data-i="${i}">
      <td class="tp-pick"><input type="checkbox" class="tp-row" data-i="${i}" ${why ? 'disabled' : ''} aria-label="Select ${esc(k.no)}"></td>
      <td>${esc(k.party)}</td><td>${esc(k.ctin)}</td><td>${esc(k.no)}</td><td>${esc(dmy(k.date))}</td>
      <td class="num">${money(k.taxable)}</td><td class="num">${money(taxOf(k))}</td>
      <td class="tp-rate">${rateCellHTML(i)}</td>
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
      <th></th><th>Supplier</th><th>GSTIN</th><th>Invoice</th><th>Date</th><th class="num">Taxable</th><th class="num">Tax</th><th>Rate</th><th>Note</th>
    </tr></thead><tbody>${body}</tbody></table></div>
    <div id="tally-push-panel"></div>
  </details>`;
}

function refreshPickState() {
  const eligible = pushRows.map((k, i) => i).filter(i => !pushBlocker(pushRows[i], i) && !pushSent.has(i));
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
    const k = pushRows[i];
    const why = pushBlocker(k, i);
    const tr = cb.closest('tr');
    tr.querySelector('.tp-rate').innerHTML = rateCellHTML(i);
    const st = tr.querySelector('.tp-state');
    if (pushSent.has(i)) {
      cb.disabled = true; cb.checked = false;
      st.textContent = 'Sent to Tally ✓'; st.className = 'tp-state sent';
      return;
    }
    cb.disabled = !!why;
    if (why) pushSel.delete(i);
    cb.checked = pushSel.has(i);
    st.textContent = why || (k.kind === 'CN' ? 'Credit note → Debit Note' : (pushSplit[i] ? 'Split across rates' : ''));
  });
}

// ── Splitting a mixed-rate invoice ──────────────────────────────────────────
// 2B has totals only, so an invoice whose tax fits no single rate is either
// left for manual booking (do nothing) or split here into per-rate lines that
// add up exactly to the invoice.

function openSplit(i) {
  const old = document.getElementById('tp-split-' + i);
  if (old) { old.remove(); return; }
  const k = pushRows[i];
  const tax = k.igst + k.cgst + k.sgst;
  const sug = BooksRecon.suggestSplits(k.taxable, tax).slice(0, 4);
  // Start from an existing split, or from the best match only when it is a clean one; otherwise a blank line.
  let parts = pushSplit[i] ? pushSplit[i].map(l => ({ rate: l.rate, taxable: l.taxable }))
    : (sug[0] && sug[0].round ? sug[0].parts.map(p => ({ ...p })) : [{ rate: 18, taxable: k.taxable }]);
  const tr = document.createElement('tr');
  tr.id = 'tp-split-' + i; tr.className = 'tp-split-row';
  tr.innerHTML = `<td colspan="9"><div class="tp-split">
    <div class="tp-split-head">Split invoice <b>${esc(k.no)}</b> — taxable ${money(k.taxable)}, tax ${money(tax)}</div>
    <div class="tp-split-sug">${sug.length
      ? 'Rates that fit this invoice (check them against the invoice): ' + sug.map((s, j) => `<button type="button" class="tp-chip" data-s="${j}">${s.parts.map(p => `${fmtRate(p.rate)}% on ${money(p.taxable)}`).join(' + ')}</button>`).join('')
      : 'No two-rate combination matches the tax exactly. Enter the lines by hand, or leave the invoice unticked and book it manually in Tally.'}</div>
    <div class="tp-split-lines"></div>
    <div class="tp-split-actions">
      <button type="button" class="btn-reset" data-act="add">Add a rate</button>
      <button type="button" class="btn-run" data-act="apply">Use this split</button>
      <button type="button" class="btn-reset" data-act="clear">${pushSplit[i] ? 'Remove split' : 'Cancel'}</button>
      <span class="tp-split-msg" role="status"></span>
    </div></div></td>`;
  document.querySelector(`tr[data-i="${i}"]`).after(tr);
  const box = tr.querySelector('.tp-split-lines');
  const msg = tr.querySelector('.tp-split-msg');
  const draw = () => {
    box.innerHTML = parts.map((p, n) => `<div class="tp-split-line" data-n="${n}">
      <select class="sp-rate" aria-label="Rate">${BooksRecon.RATE_SLABS.map(r => `<option value="${r}" ${+r === +p.rate ? 'selected' : ''}>${fmtRate(r)}%</option>`).join('')}</select>
      <input class="sp-tx" type="number" step="0.01" min="0" value="${esc(p.taxable)}" aria-label="Taxable value">
      <button type="button" class="tp-link" data-act="del" ${parts.length < 2 ? 'disabled' : ''}>Remove</button></div>`).join('');
  };
  const read = () => [...box.querySelectorAll('.tp-split-line')].map(l => ({ rate: +l.querySelector('.sp-rate').value, taxable: +l.querySelector('.sp-tx').value || 0 }));
  draw();
  tr.addEventListener('click', e => {
    const chip = e.target.closest('.tp-chip');
    if (chip) { parts = sug[+chip.dataset.s].parts.map(p => ({ ...p })); draw(); msg.textContent = ''; return; }
    const act = (e.target.closest('[data-act]') || {}).dataset;
    if (!act) return;
    if (act.act === 'add') { parts = read(); parts.push({ rate: 18, taxable: 0 }); draw(); }
    else if (act.act === 'del') { parts = read(); parts.splice(+e.target.closest('.tp-split-line').dataset.n, 1); draw(); }
    else if (act.act === 'clear') { delete pushSplit[i]; pushSel.delete(i); tr.remove(); refreshPickState(); }
    else if (act.act === 'apply') {
      const r = BooksRecon.splitInvoice(k, read());
      if (!r.ok) { msg.textContent = r.error; msg.className = 'tp-split-msg bad'; return; }
      pushSplit[i] = r.lines;
      tr.remove();
      refreshPickState();
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
      if (pushBlocker(k, i) || pushSent.has(i)) return;
      e.target.checked ? pushSel.add(i) : pushSel.delete(i);
    });
    refreshPickState();
  });
  table.closest('details').addEventListener('click', e => {
    const b = e.target.closest('.tp-split-btn');
    if (b) openSplit(+b.dataset.i);
  });
  table.addEventListener('click', openPushPanel);
  refreshPickState();
}

// ── Posting settings (remembered per company) ───────────────────────────────

const COMMON_FIELDS = [
  ['voucherType',   'Purchase voucher type', 'Purchase'],
  ['debitNoteType', 'Debit note voucher type (for credit notes)', 'Debit Note'],
  ['cess',          'Input Cess ledger (only if an invoice has cess)', ''],
];
const SINGLE_FIELDS = [
  ['purchaseLedger','Purchase ledger', ''],
  ['cgst',          'Input CGST ledger', ''],
  ['sgst',          'Input SGST ledger', ''],
  ['igst',          'Input IGST ledger', ''],
  ['returnLedger',  'Purchase return ledger (blank = purchase ledger)', ''],
];
const RATE_FIELDS = [['purchase', 'Purchase ledger'], ['cgst', 'Input CGST'], ['sgst', 'Input SGST'], ['igst', 'Input IGST']];

const cfgKey = () => 'gstr_tally_cfg_v2:' + (booksMeta.company || '');
function loadCfg() {
  const read = k => { try { return JSON.parse(localStorage.getItem(k)) || null; } catch (e) { return null; } };
  return read(cfgKey()) || read(TALLY_CFG_KEY) || {};
}
function saveCfg(c) {
  try { localStorage.setItem(cfgKey(), JSON.stringify(c)); } catch (e) { /* private mode — just don't remember */ }
}

function readCfgForm() {
  const val = id => ((document.getElementById(id) || {}).value || '').trim();
  const c = {};
  COMMON_FIELDS.forEach(([k, , def]) => { c[k] = val('tcfg-' + k) || def; });
  SINGLE_FIELDS.forEach(([k]) => { c[k] = val('tcfg-' + k); });
  const mode = ((document.querySelector('input[name="tcfg-mode"]:checked') || {}).value) === 'single' ? 'single' : 'byRate';
  const shown = {};
  document.querySelectorAll('.trm').forEach(inp => { (shown[inp.dataset.rate] = shown[inp.dataset.rate] || {})[inp.dataset.field] = inp.value.trim(); });
  const rateMap = { ...(loadCfg().rateMap || {}), ...shown };      // keep rates not on screen today
  const newLedgerGroup = val('tcfg-newLedgerGroup') || loadCfg().newLedgerGroup || 'Purchase Accounts';
  return {
    newLedgerGroup,
    voucherType: c.voucherType, debitNoteType: c.debitNoteType,
    purchaseLedger: c.purchaseLedger, returnLedger: c.returnLedger,
    taxLedgers: { cgst: c.cgst, sgst: c.sgst, igst: c.igst, cess: c.cess },
    mode, rateMap,
    _flat: { ...c, mode, rateMap, newLedgerGroup },
  };
}

/** Pre-fill empty ledger fields (one-set mode) from the ledgers actually in Tally. */
function suggestLedgers(ledgers) {
  const find = re => (ledgers.find(l => re.test(l.name)) || {}).name || '';
  return {
    purchaseLedger: (ledgers.find(l => /purchase/i.test(l.parent) && !/return/i.test(l.name)) || ledgers.find(l => /^purchase/i.test(l.name) && !/return/i.test(l.name)) || {}).name || '',
    cgst: find(/input.*cgst|cgst.*input/i), sgst: find(/input.*(sgst|utgst)|(sgst|utgst).*input/i),
    igst: find(/input.*igst|igst.*input/i), cess: find(/input.*cess|cess.*input/i),
    returnLedger: find(/purchase.*return|return.*purchase/i),
  };
}

/** Ledgers whose names carry this rate, e.g. "Input CGST @ 9%" for a rate of 18. */
function suggestForRate(rate, ledgers) {
  const has = r => { const re = new RegExp('(^|[^\\d.])' + fmtRate(r).replace('.', '\\.') + '(\\.0+)?\\s*%'); return n => re.test(n); };
  const full = has(rate), half = has(rate / 2);
  const pick = (re, fn) => (ledgers.find(l => re.test(l.name) && fn(l.name)) || {}).name || '';
  return {
    purchase: pick(/purchase/i, n => !/return/i.test(n) && full(n)),
    cgst: pick(/cgst/i, n => !/output/i.test(n) && half(n)),
    sgst: pick(/(sgst|utgst)/i, n => !/output/i.test(n) && half(n)),
    igst: pick(/igst/i, n => !/output/i.test(n) && full(n)),
  };
}

/** Name for a rate's ledger when Tally has none: 18% → "Input CGST @ 9%", "Input IGST @ 18%", "Purchase @ 18%". */
function standardLedgerName(field, rate) {
  const full = fmtRate(rate), half = fmtRate(rate / 2);
  return { purchase: `Purchase @ ${full}%`, cgst: `Input CGST @ ${half}%`, sgst: `Input SGST @ ${half}%`, igst: `Input IGST @ ${full}%` }[field] || '';
}

const looksRateWise =ledgers => ledgers.some(l => /(cgst|sgst|igst|purchase)[^%]*\d+(\.\d+)?\s*%/i.test(l.name));

// ── The push panel: settings → preview → confirm → results ─────────────────

function selectedVouchers() {
  return [...pushSel].sort((a, b) => a - b).map(i => {
    const k = pushRows[i];
    const lines = pushSplit[i] || (k._rate === null ? null : [{ rate: k._rate, taxable: k.taxable, igst: k.igst, cgst: k.cgst, sgst: k.sgst, cess: k.cess }]);
    return {
      _row: i, date: BooksRecon.isoDate(k.date), invoiceNo: k.no, party: k.party, gstin: k.ctin, pos: k.pos,
      taxable: k.taxable, igst: k.igst, cgst: k.cgst, sgst: k.sgst, cess: k.cess, kind: k.kind, lines,
      partyLedger: canCreateLedgers() ? (partyOverrides[i] || '') : '',
    };
  });
}

function wireVoucher(v) { const { _row, ...rest } = v; return rest; }

/** Ask the extension to create missing purchase / tax ledgers (1.12.0+ only; older ones keep reporting them as missing). */
function createFlags(cfg) {
  return canCreateLedgers() ? { createLedgers: true, newLedgerGroup: cfg.newLedgerGroup || 'Purchase Accounts' } : {};
}

/** The rates present in the selection, and which tax heads each needs. */
function selectedRates() {
  const m = new Map();
  selectedVouchers().forEach(v => (v.lines || []).forEach(l => {
    const key = fmtRate(l.rate);
    const e = m.get(key) || { rate: l.rate, intra: false, inter: false };
    if (l.cgst > 0 || l.sgst > 0) e.intra = true;
    if (l.igst > 0) e.inter = true;
    m.set(key, e);
  }));
  return [...m.values()].sort((a, b) => a.rate - b.rate);
}

async function openPushPanel() {
  const panel = document.getElementById('tally-push-panel');
  panel.innerHTML = '<div class="tp-panel"><p class="bk-note">Reading ledgers from Tally…</p></div>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const vouchers = selectedVouchers();
    // First pass only to learn which ledgers exist, so settings can be suggested.
    const first = await tallyRequest('plan', { vouchers: vouchers.map(wireVoucher), config: readStoredCfgForPlan() }, 60000);
    planItems = first.items || [];
    renderPushPanel(first.ledgers || []);
    await refreshPreview();
  } catch (err) {
    panel.innerHTML = `<div class="tp-panel"><div class="notice notice-error"><span>${esc(err.message)}</span></div></div>`;
  }
}

function readStoredCfgForPlan() {
  return { voucherType: 'Purchase', debitNoteType: 'Debit Note', purchaseLedger: '', returnLedger: '', taxLedgers: {}, mode: 'single', rateMap: {} };
}

let knownLedgers = [];
let planItems = [];             // supplier ledger per selected invoice, as Tally resolved it
let lineOverrides = {};         // "row:line" -> { field: ledger } typed against one invoice line
let partyOverrides = {};        // row -> supplier ledger typed for that invoice (e.g. an existing "Act Fiber Net")
let editTaxPerInvoice = false;  // step 2 shows tax ledgers as text unless this is ticked
let lineIndex = new Map();      // "row:line" -> { v, l }
let previewTimer = null;

const LINE_FIELDS = [['purchase', 'Purchase ledger'], ['cgst', 'Input CGST'], ['sgst', 'Input SGST'], ['igst', 'Input IGST']];
const needsField = (l, f) => (f === 'purchase' ? l.taxable > 0 : l[f] > 0);
const currentMode = () => (((document.querySelector('input[name="tcfg-mode"]:checked') || {}).value) === 'single' ? 'single' : 'byRate');

/** The ledgers an invoice line gets from the defaults (step 1). */
function defaultLedgers(v, l) {
  const val = id => ((document.getElementById(id) || {}).value || '').trim();
  const cess = val('tcfg-cess');
  if (currentMode() === 'single') {
    const purchase = v.kind === 'CN' ? (val('tcfg-returnLedger') || val('tcfg-purchaseLedger')) : val('tcfg-purchaseLedger');
    return { purchase, cgst: val('tcfg-cgst'), sgst: val('tcfg-sgst'), igst: val('tcfg-igst'), cess };
  }
  const key = fmtRate(l.rate);
  const get = f => ((document.querySelector(`.trm[data-rate="${key}"][data-field="${f}"]`) || {}).value || '').trim();
  return { purchase: get('purchase'), cgst: get('cgst'), sgst: get('sgst'), igst: get('igst'), cess };
}
const effectiveLedgers = (v, l, key) => ({ ...defaultLedgers(v, l), ...(lineOverrides[key] || {}) });

/** Selected invoices with the ledgers each line will post to. */
function vouchersWithLedgers() {
  return selectedVouchers().map(v => ({
    ...v, lines: (v.lines || []).map((l, n) => ({ ...l, ledgers: effectiveLedgers(v, l, `${v._row}:${n}`) })),
  }));
}

const partyResetHTML = row => (row in partyOverrides ? `<button type="button" class="tp-link" data-party-reset="${row}">Reset</button>` : '');

function invoiceTableHTML() {
  lineIndex = new Map();
  const rows = selectedVouchers().map((v, vi) => {
    const lines = v.lines || [];
    const party = planItems[vi] || { partyLedger: v.party, isNew: false };
    return lines.map((l, n) => {
      const key = `${v._row}:${n}`;
      lineIndex.set(key, { v, l });
      const ovr = lineOverrides[key] || {};
      const eff = effectiveLedgers(v, l, key);
      const partyCell = canCreateLedgers()
        ? `<input type="text" class="tparty${v._row in partyOverrides ? ' ovr' : ''}" list="tally-ledgers" data-row="${v._row}" value="${esc(partyOverrides[v._row] || party.partyLedger)}" autocomplete="off" aria-label="${esc(v.invoiceNo)} supplier ledger" title="Post against any ledger in Tally, or type a new name to create one">`
        : esc(party.partyLedger);
      // Badge and Reset sit under the box: table cells don't wrap, so beside it they ran into the Invoice column.
      const head = n === 0 ? `
        <td rowspan="${lines.length}"><div class="tp-party">${partyCell}<div class="tp-party-meta"><span class="tp-party-badge">${party.isNew ? '<span class="bk-badge warn">new ledger</span>' : ''}</span><span class="tp-party-reset">${partyResetHTML(v._row)}</span></div></div></td>
        <td rowspan="${lines.length}">${esc(v.invoiceNo)}${v.kind === 'CN' ? '<div class="tp-sub">Credit note → Debit Note</div>' : ''}</td>` : '';
      // Tax ledgers follow step 1 and show as text; they become boxes only when asked for (or already changed).
      const cells = LINE_FIELDS.map(([f, label]) => !needsField(l, f) ? '<td class="tp-na">–</td>'
        : (f !== 'purchase' && !editTaxPerInvoice && !(f in ovr)) ? `<td class="tp-auto">${esc(eff[f])}</td>`
        : `<td><input type="text" class="tl${f in ovr ? ' ovr' : ''}" list="tally-ledgers" data-key="${key}" data-field="${f}" value="${esc(eff[f])}" autocomplete="off" aria-label="${esc(v.invoiceNo)} ${esc(label)}"></td>`).join('');
      const reset = Object.keys(ovr).length ? `<button type="button" class="tp-link" data-reset="${key}">Reset</button>` : '';
      return `<tr>${head}<td>${esc(fmtRate(l.rate))}%</td><td class="num">${money(l.taxable)}</td>
        <td class="num">${money(l.igst + l.cgst + l.sgst + l.cess)}</td>${cells}<td class="tp-reset">${reset}</td></tr>`;
    }).join('');
  }).join('');
  return `<div style="overflow-x:auto"><table class="bk-table tp-lines"><thead><tr>
    <th>Supplier ledger</th><th>Invoice</th><th>Rate</th><th class="num">Taxable</th><th class="num">Tax</th>
    ${LINE_FIELDS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Put the current defaults into every invoice cell the user has not changed. */
function syncLineInputs() {
  document.querySelectorAll('.tl').forEach(inp => {
    const key = inp.dataset.key, f = inp.dataset.field;
    if ((lineOverrides[key] || {})[f] !== undefined) return;
    const { v, l } = lineIndex.get(key);
    inp.value = defaultLedgers(v, l)[f];
  });
}

function redrawInvoiceTable() {
  document.getElementById('tp-lines').innerHTML = invoiceTableHTML();
}

function schedulePreview() {
  const confirm = document.getElementById('btn-tally-confirm');
  if (confirm) confirm.disabled = true;
  const hint = document.getElementById('tp-preview-state');
  if (hint) hint.textContent = 'Updating…';
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 500);
}

function renderPushPanel(ledgers) {
  knownLedgers = ledgers;
  editTaxPerInvoice = false;
  const stored = loadCfg();
  const sug = suggestLedgers(ledgers);
  const suggested = [];
  const val = (k, def) => {
    if (stored[k]) return stored[k];
    if (sug[k]) { suggested.push(k); return sug[k]; }
    return def;
  };
  const mode = stored.mode || (looksRateWise(ledgers) ? 'byRate' : 'single');
  const options = ledgers.map(l => `<option value="${esc(l.name)}">${esc(l.parent)}</option>`).join('');
  const input = (attrs, v) => `<input type="text" list="tally-ledgers" value="${esc(v)}" autocomplete="off" ${attrs}>`;
  const field = ([k, label, def]) => `<label class="tp-field"><span>${esc(label)}</span>${input(`id="tcfg-${k}" class="tdef"`, val(k, def))}</label>`;

  let rateSuggested = false;
  const rateRows = selectedRates().map(r => {
    const key = fmtRate(r.rate);
    const saved = (stored.rateMap || {})[key] || {};
    const guess = suggestForRate(r.rate, ledgers);
    const cells = RATE_FIELDS.map(([f]) => {
      const needed = f === 'purchase' || ((f === 'igst' ? r.inter : r.intra) && r.rate > 0);
      if (!needed) return '<td class="tp-na">–</td>';
      let v = saved[f] || '';
      if (!v && guess[f]) { v = guess[f]; rateSuggested = true; }
      // Nothing in Tally for this rate: name it from the rate; the extension creates it on Create.
      if (!v && canCreateLedgers()) v = standardLedgerName(f, r.rate);
      return `<td>${input(`class="trm tdef" data-rate="${esc(key)}" data-field="${f}" aria-label="${esc(key)}% ${f}"`, v)}</td>`;
    }).join('');
    return `<tr><td class="tp-ratecol">${esc(key)}%</td>${cells}</tr>`;
  }).join('');

  const panel = document.getElementById('tally-push-panel');
  panel.innerHTML = `
    <div class="tp-panel">
      <h4>Send to Tally</h4>
      <p class="bk-note">Posting into <b>${esc(booksMeta.company)}</b>. Nothing is written to Tally until you click Create.</p>
      <datalist id="tally-ledgers">${options}</datalist>

      <div class="tp-step">1. Your usual purchase and tax ledgers</div>
      <p class="tp-intro">Set these once. Every invoice in step 2 is filled in with them, so you don't type the same ledgers on each row — you only change the invoices that are different. They are remembered for <b>${esc(booksMeta.company)}</b> in this browser.${(suggested.length || rateSuggested) ? ' Some were guessed from your Tally ledger names; check them.' : ''}${canCreateLedgers() ? ' Where Tally has no ledger for a rate, a name like <i>Input CGST @ 9%</i> is filled in from the rate and created for you.' : ''}</p>
      <div class="tp-mode" role="radiogroup" aria-label="How the usual ledgers are chosen">
        <label><input type="radio" name="tcfg-mode" value="byRate" ${mode === 'byRate' ? 'checked' : ''}> Separate ledgers for each GST rate <span class="tp-sub">(e.g. Purchase @ 18 %, INPUT CGST @ 9%)</span></label>
        <label><input type="radio" name="tcfg-mode" value="single" ${mode === 'single' ? 'checked' : ''}> The same ledgers for every rate</label>
      </div>
      <div id="tp-by-rate" ${mode === 'byRate' ? '' : 'hidden'}>
        <div style="overflow-x:auto"><table class="bk-table tp-rates"><thead><tr><th>Rate</th>${RATE_FIELDS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>${rateRows}</tbody></table></div>
      </div>
      <div id="tp-single" ${mode === 'single' ? '' : 'hidden'}><div class="tp-fields">${SINGLE_FIELDS.map(field).join('')}</div></div>
      <details class="tp-more">
        <summary>Other settings — voucher types, cess${canCreateLedgers() ? ', where new ledgers go' : ''}</summary>
        <div class="tp-fields">${COMMON_FIELDS.map(field).join('')}${canCreateLedgers() ? `
          <label class="tp-field"><span>New purchase ledgers go under</span><select id="tcfg-newLedgerGroup" class="tdef">${
            NEW_LEDGER_GROUPS.map(g => `<option ${g === (stored.newLedgerGroup || 'Purchase Accounts') ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>` : ''}</div>
      </details>

      <div class="tp-step">2. Check each invoice</div>
      <p class="tp-intro">Each row is filled in from step 1. Change a box only for an invoice that goes somewhere else; changed boxes turn yellow and can be reset.${canCreateLedgers() ? ' <b>Supplier ledger</b>: pick any ledger already in Tally (for example Act Fiber Net for Atria), or type a new name to create one. Any ledger name that is not in Tally is created when you click Create.' : ''}</p>
      <label class="tp-toggle"><input type="checkbox" id="tp-edit-tax"> Change tax ledgers on single invoices</label>
      <div id="tp-lines"></div>

      <div class="tp-step">3. Check and create <span class="run-hint" id="tp-preview-state"></span></div>
      <div id="tally-preview"></div>
    </div>`;

  // Filled only now: each invoice's ledgers are read from the defaults above, which must exist first.
  redrawInvoiceTable();

  panel.addEventListener('input', e => {
    const t = e.target;
    if (t.classList.contains('tparty')) {
      const row = +t.dataset.row;
      const vi = selectedVouchers().findIndex(v => v._row === row);
      const resolved = ((planItems[vi] || {}).partyLedger) || '';
      if (!t.value.trim() || t.value.trim() === resolved) delete partyOverrides[row];
      else partyOverrides[row] = t.value.trim();
      t.classList.toggle('ovr', row in partyOverrides);
      const reset = t.closest('.tp-party').querySelector('.tp-party-reset');
      if (reset) reset.innerHTML = partyResetHTML(row);
      schedulePreview();
    } else if (t.classList.contains('tl')) {
      const key = t.dataset.key, f = t.dataset.field;
      const { v, l } = lineIndex.get(key);
      const def = defaultLedgers(v, l)[f];
      lineOverrides[key] = lineOverrides[key] || {};
      if (t.value.trim() === def) delete lineOverrides[key][f]; else lineOverrides[key][f] = t.value.trim();
      if (!Object.keys(lineOverrides[key]).length) delete lineOverrides[key];
      t.classList.toggle('ovr', f in (lineOverrides[key] || {}));
      const cell = t.closest('tr').querySelector('.tp-reset');
      cell.innerHTML = lineOverrides[key] ? `<button type="button" class="tp-link" data-reset="${key}">Reset</button>` : '';
      schedulePreview();
    } else if (t.classList.contains('tdef')) {
      syncLineInputs();
      document.querySelectorAll('.tp-lines .tp-auto').length && redrawInvoiceTable();   // text cells follow step 1 too
      schedulePreview();
    }
  });
  panel.addEventListener('change', e => {
    if (e.target.id === 'tcfg-newLedgerGroup') schedulePreview();
    if (e.target.id === 'tp-edit-tax') { editTaxPerInvoice = e.target.checked; redrawInvoiceTable(); }
  });
  panel.addEventListener('click', e => {
    const pr = e.target.closest('[data-party-reset]');
    if (pr) { delete partyOverrides[pr.dataset.partyReset]; redrawInvoiceTable(); schedulePreview(); return; }
    const b = e.target.closest('[data-reset]');
    if (!b) return;
    delete lineOverrides[b.dataset.reset];
    redrawInvoiceTable();
    schedulePreview();
  });
  document.querySelectorAll('input[name="tcfg-mode"]').forEach(r => r.addEventListener('change', () => {
    const by = currentMode() === 'byRate';
    document.getElementById('tp-by-rate').hidden = !by;
    document.getElementById('tp-single').hidden = by;
    syncLineInputs();
    schedulePreview();
  }));
}

async function refreshPreview() {
  clearTimeout(previewTimer);
  const box = document.getElementById('tally-preview');
  const state = document.getElementById('tp-preview-state');
  const cfg = readCfgForm();
  saveCfg(cfg._flat);
  if (state) state.textContent = 'Checking against Tally…';
  const vouchers = vouchersWithLedgers();
  try {
    const plan = await tallyRequest('plan', { vouchers: vouchers.map(wireVoucher), config: cfg, ...createFlags(cfg) }, 60000);
    if (state) state.textContent = '';
    planItems = plan.items || planItems;
    // Keep the "new ledger" badge next to each supplier cell in step with Tally's answer.
    document.querySelectorAll('.tparty').forEach(inp => {
      const vi = vouchers.findIndex(v => v._row === +inp.dataset.row);
      const badge = inp.parentElement.querySelector('.tp-party-badge');
      if (badge && planItems[vi]) badge.innerHTML = planItems[vi].isNew ? '<span class="bk-badge warn">new ledger</span>' : '';
    });
    const newCount = new Set(plan.items.filter(p => p.isNew).map(p => p.partyLedger)).size;
    const toCreate = plan.create || [];
    const already = plan.already || [];                 // invoices Tally already has: skipped on Create
    const toBook = vouchers.length - already.length;
    const byRate = new Map();
    vouchers.forEach(v => (v.lines || []).forEach(l => {
      const key = fmtRate(l.rate), sign = v.kind === 'CN' ? -1 : 1;
      const e = byRate.get(key) || { rate: l.rate, n: new Set(), taxable: 0, tax: 0 };
      e.n.add(v._row); e.taxable += sign * l.taxable; e.tax += sign * (l.igst + l.cgst + l.sgst + l.cess);
      byRate.set(key, e);
    }));
    const rateTable = [...byRate.values()].sort((a, b) => a.rate - b.rate).map(e =>
      `<tr><td>${esc(fmtRate(e.rate))}%</td><td class="num">${e.n.size}</td><td class="num">${money(e.taxable)}</td><td class="num">${money(e.tax)}</td></tr>`).join('');
    const problems = [];
    if ((plan.unmapped || []).length) problems.push(`Choose a ledger for: ${plan.unmapped.join('; ')}`);
    if (plan.missing.length) problems.push(`These ledgers are not in Tally — pick existing ones: ${plan.missing.map(m => m || '(blank)').join(', ')}`);
    box.innerHTML = `
      <div class="summary-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="summary-card"><div class="sc-label">Vouchers to create</div><div class="sc-value">${toBook}</div><div class="sc-sub">${esc(booksMeta.company)}</div></div>
        <div class="summary-card"><div class="sc-label">New supplier ledgers</div><div class="sc-value ${newCount ? 'mismatch' : 'match'}">${newCount}</div><div class="sc-sub">created under Sundry Creditors</div></div>
        <div class="summary-card"><div class="sc-label">Input tax booked</div><div class="sc-value">₹${money(vouchers.reduce((s, v) => s + (v.kind === 'CN' ? -1 : 1) * (v.igst + v.cgst + v.sgst + v.cess), 0))}</div><div class="sc-sub">net of debit notes</div></div>
      </div>
      ${problems.map(t => `<div class="notice notice-error" style="margin-bottom:10px"><span>${esc(t)}</span></div>`).join('')}
      ${already.length ? `<div class="notice notice-warn" style="margin-bottom:10px"><span>Already in Tally, so they will be skipped (not booked twice): ${
        already.map(a => `<b>${esc(a.invoiceNo)}</b> (voucher ${esc(a.voucherNo)}, ${esc(a.party)})`).join(', ')}.</span></div>` : ''}
      ${toCreate.length ? `<div class="notice notice-warn" style="margin-bottom:10px"><span>These ledgers are not in Tally and will be created: ${
        toCreate.map(c => `<b>${esc(c.name)}</b> (${esc(c.group)}${c.role === 'purchase' ? '' : ', GST ' + esc(c.role.toUpperCase())})`).join(', ')}. To use an existing ledger instead, pick it from the list.</span></div>` : ''}
      ${rateTable ? `<div style="overflow-x:auto"><table class="bk-table tp-ratesum"><thead><tr><th>Rate</th><th class="num">Vouchers</th><th class="num">Taxable</th><th class="num">Tax</th></tr></thead><tbody>${rateTable}</tbody></table></div>` : ''}
      <div class="tp-actions">
        <button type="button" class="btn-run" id="btn-tally-confirm" ${problems.length || !toBook ? 'disabled' : ''}>Create ${toBook} voucher${toBook === 1 ? '' : 's'} in Tally</button>
        <span class="run-hint">Check the first voucher in Tally before booking the rest.</span>
      </div>
      <div id="tally-result"></div>`;
    const confirm = document.getElementById('btn-tally-confirm');
    if (confirm) confirm.addEventListener('click', () => confirmPush(vouchers, cfg));
  } catch (err) {
    if (state) state.textContent = '';
    box.innerHTML = `<div class="notice notice-error"><span>${esc(err.message)}</span></div>`;
  }
}

async function confirmPush(vouchers, cfg) {
  const btn = document.getElementById('btn-tally-confirm');
  const out = document.getElementById('tally-result');
  btn.disabled = true;
  document.querySelectorAll('#tally-push-panel input, #tally-push-panel select').forEach(i => { i.disabled = true; });
  const results = [];
  const ledgersMade = [];
  try {
    for (let at = 0; at < vouchers.length; at += PUSH_CHUNK) {
      const chunk = vouchers.slice(at, at + PUSH_CHUNK);
      btn.textContent = `Sending… ${at}/${vouchers.length}`;
      const resp = await tallyRequest('push', {
        company: booksMeta.company, config: cfg, createSuppliers: true, ...createFlags(cfg),
        vouchers: chunk.map(wireVoucher),
      }, 10 * 60 * 1000);
      (resp.ledgersCreated || []).forEach(n => ledgersMade.push(n));
      resp.results.forEach((r, j) => results.push({ ...r, _row: chunk[j]._row }));
    }
  } catch (err) {
    out.innerHTML = `<div class="notice notice-error"><span>Stopped after ${results.length} of ${vouchers.length}: ${esc(err.message)}</span></div>`;
  }

  results.filter(r => r.ok || r.skipped).forEach(r => { pushSent.add(r._row); pushSel.delete(r._row); });
  refreshPickState();
  const ok = results.filter(r => r.ok), skipped = results.filter(r => r.skipped), bad = results.filter(r => !r.ok && !r.skipped);
  const made = results.filter(r => r.ledgerCreated).length;
  btn.textContent = 'Done';
  const summary = `${ok.length} voucher${ok.length === 1 ? '' : 's'} created in Tally${made ? `, ${made} new supplier ledger${made === 1 ? '' : 's'}` : ''}${ledgersMade.length ? `, ${ledgersMade.length} new purchase/tax ledger${ledgersMade.length === 1 ? '' : 's'} (${ledgersMade.join(', ')})` : ''}${skipped.length ? `, ${skipped.length} skipped as already in Tally` : ''}${bad.length ? `, ${bad.length} failed` : ''}.`;
  // Everything went in: read Tally again straight away and show the new numbers.
  // (With failures, stay here so the failed invoices and their reasons remain on screen.)
  if ((ok.length || skipped.length) && !bad.length && results.length === vouchers.length) {
    btn.textContent = 'Done — refreshing from Tally…';
    await refreshAfterPush(summary + ' Your books were re-read from Tally:');
    return;
  }
  out.insertAdjacentHTML('afterbegin', `
    <div class="notice ${bad.length ? 'notice-warn' : 'notice-ok'}" style="margin:12px 0"><span>${esc(summary)}</span></div>
    ${bad.length ? `<div style="overflow-x:auto"><table class="bk-table"><thead><tr><th>Invoice</th><th>Supplier</th><th>Problem</th></tr></thead><tbody>${
      bad.map(r => `<tr><td>${esc(r.invoiceNo)}</td><td>${esc(r.party)}</td><td>${esc(r.error)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${ok.length ? '<div class="tp-actions"><button type="button" class="btn-run" id="btn-tally-reimport">Re-import from Tally and reconcile again</button></div>' : ''}`);
  const re = document.getElementById('btn-tally-reimport');
  if (re) re.addEventListener('click', importFromTally);
}

// ── After a push: re-read Tally and show what changed ───────────────────────

/** The summary cards' numbers, by label. */
function cardNumbers() {
  const m = {};
  document.querySelectorAll('#books-results .summary-card').forEach(c => {
    m[c.querySelector('.sc-label').textContent] = parseInt(c.querySelector('.sc-value').textContent.replace(/[^\d-]/g, ''), 10) || 0;
  });
  return m;
}

async function refreshAfterPush(message) {
  const before = cardNumbers();
  await importFromTally();                 // re-reads Tally and redraws the comparison
  booksNotice('ok', message + ' ' + cardChangesText(before));
  celebrateCards(before);
}

function cardChangesText(before) {
  const after = cardNumbers();
  const moved = Object.keys(after).filter(k => k in before && before[k] !== after[k]).map(k => `${k} ${before[k]} → ${after[k]}`);
  return moved.length ? moved.join(', ') + '.' : 'no change in the counts.';
}

/** Count each changed card from its old number to the new one, flag the change, and a short burst. */
function celebrateCards(before) {
  const grid = document.querySelector('#books-results .summary-grid');
  if (!grid) return;
  grid.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let any = false;
  grid.querySelectorAll('.summary-card').forEach((card, i) => {
    const label = card.querySelector('.sc-label').textContent;
    const el = card.querySelector('.sc-value');
    const to = parseInt(el.textContent.replace(/[^\d-]/g, ''), 10) || 0;
    if (!(label in before) || before[label] === to) return;
    any = true;
    const from = before[label], d = to - from;
    const good = label === 'Matched' ? d > 0 : d < 0;      // more matched, fewer exceptions
    card.classList.add('sc-changed');
    card.style.animationDelay = (i * 90) + 'ms';
    card.insertAdjacentHTML('beforeend', `<span class="sc-delta ${good ? 'good' : 'bad'}">${d > 0 ? '+' : '−'}${Math.abs(d)}</span>`);
    if (calm) return;
    const start = performance.now() + i * 90, dur = 1100;
    el.textContent = from;
    (function tick(now) {
      const t = Math.min(1, Math.max(0, (now - start) / dur));
      el.textContent = Math.round(from + d * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(tick);
    })(performance.now());
  });
  if (any && !calm) burst(grid);
}

function burst(host) {
  const box = document.createElement('div');
  box.className = 'tp-burst';
  const colours = ['#16a34a', '#f59e0b', '#2563eb', '#e11d48', '#facc15', '#0d9488'];
  for (let i = 0; i < 46; i++) {
    const p = document.createElement('i');
    const a = Math.random() * Math.PI * 2, dist = 90 + Math.random() * 220;
    p.style.setProperty('--dx', Math.cos(a) * dist + 'px');
    p.style.setProperty('--dy', Math.sin(a) * dist * 0.6 - 40 + 'px');
    p.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
    p.style.setProperty('--c', colours[i % colours.length]);
    p.style.animationDelay = Math.random() * 120 + 'ms';
    box.appendChild(p);
  }
  host.appendChild(box);
  setTimeout(() => box.remove(), 1800);
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
