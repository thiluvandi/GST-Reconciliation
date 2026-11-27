/**
 * books-ui.js
 * Page wiring for the GSTR-2B vs Books (invoice-wise) section: loading the
 * purchase register (CSV/JSON, or pushed in by the browser extension from
 * Tally), running the matcher, and rendering what it found.
 *
 * Relies on globals from app.js (files, escapeHtml, addNotice) and
 * tables.js (fmt), plus BooksRecon from booksrecon.js.
 */

const BOOKS_TEMPLATE_HEADERS = ['Date', 'Voucher No', 'Supplier Invoice No', 'Party', 'GSTIN', 'Taxable', 'IGST', 'CGST', 'SGST', 'Cess', 'Total', 'Type'];

let booksRows = [];
let booksLoaded = false;   // true once a register has been loaded — even an empty one from Tally
let booksLabel = '';
let booksResult = null;
// Which Tally company the rows came from (empty for a CSV/JSON file). Sending
// invoices back to Tally is only allowed when this is known.
let booksMeta = { company: '', companyGstins: [] };

// ── Reading a purchase register ─────────────────────────────────────────────

/** Minimal RFC-4180-ish CSV reader (quoted fields, embedded commas/quotes/newlines). */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

// Column headers vary between exports, so match on a loose key.
const COLUMN_ALIASES = {
  date: ['date', 'voucherdate', 'invoicedate'],
  voucherNo: ['voucherno', 'vchno', 'voucher', 'vouchernumber'],
  invoiceNo: ['supplierinvoiceno', 'invoiceno', 'invno', 'reference', 'refno', 'supplierinvoice', 'billno'],
  party: ['party', 'partyname', 'partyledger', 'supplier', 'suppliername', 'ledger'],
  gstin: ['gstin', 'partygstin', 'gstno', 'gstinuin', 'suppliergstin'],
  taxable: ['taxable', 'taxablevalue', 'taxableamount', 'assessablevalue'],
  igst: ['igst', 'integratedtax'],
  cgst: ['cgst', 'centraltax'],
  sgst: ['sgst', 'sgstutgst', 'statetax', 'statetax', 'utgst'],
  cess: ['cess'],
  total: ['total', 'invoicevalue', 'grossamount', 'amount'],
  kind: ['type', 'vouchertype', 'kind'],
};
const looseKey = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function booksRowsFromCSV(text) {
  const table = parseCSV(text);
  if (table.length < 2) throw new Error('The file has no data rows.');
  const header = table[0].map(looseKey);
  const col = {};
  Object.entries(COLUMN_ALIASES).forEach(([field, aliases]) => {
    col[field] = header.findIndex(h => aliases.includes(h));
  });
  const missing = ['date', 'invoiceNo', 'taxable'].filter(f => col[f] < 0);
  if (missing.length) throw new Error(`Couldn't find column(s): ${missing.join(', ')}. Use "Download CSV template" for the expected layout.`);

  return table.slice(1).map(cells => {
    const get = f => (col[f] >= 0 ? (cells[col[f]] || '').trim() : '');
    const type = get('kind');
    return {
      date: get('date'), voucherNo: get('voucherNo'), invoiceNo: get('invoiceNo'), party: get('party'),
      gstin: get('gstin'), taxable: get('taxable'), igst: get('igst'), cgst: get('cgst'), sgst: get('sgst'),
      cess: get('cess'), total: get('total'),
      // anything that reads as a return / debit note is a reduction of purchases
      kind: /return|credit|debit|\bcn\b|\bdn\b/i.test(type) ? 'CN' : 'INV',
    };
  }).filter(r => r.invoiceNo || r.voucherNo);
}

function setBooks(rows, label, meta) {
  booksRows = rows;
  booksLoaded = true;
  booksLabel = label || 'purchase register';
  booksMeta = { company: (meta && meta.company) || '', companyGstins: (meta && meta.companyGstins) || [] };
  booksResult = null;
  document.getElementById('books-results').style.display = 'none';
  refreshBooksControls();
}

function refreshBooksControls() {
  const have2b = Object.keys(files['2b']).length;
  const run = document.getElementById('btn-books-run');
  const hint = document.getElementById('books-hint');
  run.disabled = !(have2b && booksLoaded);
  const months = `${have2b} GSTR-2B month${have2b === 1 ? '' : 's'}`;
  if (!have2b && !booksLoaded) hint.textContent = 'Load GSTR-2B above, then import your purchase register from Tally.';
  else if (!have2b) hint.textContent = booksRows.length
    ? `${booksRows.length} purchase entries loaded from ${booksLabel} — now add GSTR-2B files above.`
    : `${booksLabel} has no purchase entries for that period — now add GSTR-2B files above.`;
  else if (!booksLoaded) hint.textContent = `${months} loaded — now import the purchase register from Tally.`;
  else if (!booksRows.length) hint.textContent = `${booksLabel} has no purchase entries for that period — every GSTR-2B invoice will be shown as missing from your books.`;
  else hint.textContent = `${booksRows.length} purchase entries (${booksLabel}) vs ${months} — ready.`;
}

function booksNotice(type, text) {
  const list = document.getElementById('books-notices');
  const item = document.createElement('div');
  item.className = 'notice notice-' + type;
  item.innerHTML = `<span>${escapeHtml(text)}</span><button type="button" class="notice-x" aria-label="Dismiss">&times;</button>`;
  item.querySelector('.notice-x').addEventListener('click', () => item.remove());
  list.appendChild(item);
}

// ── Rendering ───────────────────────────────────────────────────────────────

const dmy = d => { const s = BooksRecon.isoDate(d); return s ? s.split('-').reverse().join('-') : ''; };
const taxOf = r => r.igst + r.cgst + r.sgst + r.cess;
const money = n => (typeof fmt === 'function' ? fmt(n) : Number(n).toFixed(2));
const esc = s => escapeHtml(String(s ?? ''));

function tableHTML(columns, rows) {
  const head = columns.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows.map(r => '<tr>' + columns.map(c => {
    const v = c.get(r);
    const cls = [c.num ? 'num' : '', c.neg && typeof v === 'number' && v < 0 ? 'neg' : ''].join(' ').trim();
    return `<td class="${cls}">${c.num && typeof v === 'number' ? money(v) : esc(v)}</td>`;
  }).join('') + '</tr>').join('');
  return `<table class="bk-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function section(title, tag, note, columns, rows, { open = true } = {}) {
  if (!rows.length) return '';
  const badge = `<span class="bk-badge ${tag}">${rows.length}</span>`;
  return `<details class="table-wrap bk-details" ${open ? 'open' : ''}>
    <summary>${esc(title)}${badge}</summary>
    ${note ? `<p class="bk-note" style="padding:0 14px">${esc(note)}</p>` : ''}
    <div style="overflow-x:auto">${tableHTML(columns, rows)}</div>
  </details>`;
}

const pairCols = [
  { label: 'Supplier', get: e => e.twoB.party || e.books.party },
  { label: 'GSTIN', get: e => e.twoB.ctin || e.books.ctin },
  { label: 'Invoice (books)', get: e => e.books.no },
  { label: 'Invoice (2B)', get: e => e.twoB.no },
  { label: 'Date (2B)', get: e => dmy(e.twoB.date) },
  { label: 'Tax books', num: true, get: e => taxOf(e.books) },
  { label: 'Tax 2B', num: true, get: e => taxOf(e.twoB) },
  { label: 'Difference', num: true, neg: true, get: e => e.diff.tax },
];
const only2bCols = [
  { label: 'Supplier', get: k => k.party }, { label: 'GSTIN', get: k => k.ctin },
  { label: 'Invoice', get: k => k.no }, { label: 'Date', get: k => dmy(k.date) },
  { label: 'Taxable', num: true, get: k => k.taxable }, { label: 'Tax', num: true, get: k => taxOf(k) },
  { label: 'ITC', get: k => (k.itcAvailable ? 'Available' : 'Not available') },
];
const onlyBooksCols = [
  { label: 'Voucher', get: b => b.voucherNo }, { label: 'Party', get: b => b.party },
  { label: 'GSTIN in books', get: b => b.ctin || b.gstinRaw || '—' },
  { label: 'Invoice', get: b => b.no }, { label: 'Date', get: b => dmy(b.date) },
  { label: 'Taxable', num: true, get: b => b.taxable }, { label: 'Tax', num: true, get: b => taxOf(b) },
];

function renderBooksResult(r) {
  const c = r.summary.counts, itc = r.summary.itc;
  const card = (label, value, sub, cls = '') =>
    `<div class="summary-card"><div class="sc-label">${esc(label)}</div><div class="sc-value ${cls}">${value}</div><div class="sc-sub">${esc(sub)}</div></div>`;

  const cards = [
    card('Matched', c.matched, `of ${c.books} book entries${c.smartMatched ? ` · ${c.smartMatched} by smart matching` : ''}`, 'match'),
    card('Amount differs', c.differs, 'same invoice, different tax', c.differs ? 'mismatch' : 'match'),
    card('Need your check', c.probable + c.possible, `${c.probable} probable · ${c.possible} possible`, (c.probable + c.possible) ? 'mismatch' : 'match'),
    card('In 2B, not in books', c.only2b, `ITC ₹${money(itc.only2b)} not yet booked`, c.only2b ? 'mismatch' : 'match'),
    card('In books, not in 2B', c.onlyBooks + c.noGstin, `ITC ₹${money(itc.onlyBooks)} supplier hasn't reported${c.bookedTwice ? ` · ${c.bookedTwice} booked twice` : ''}`, (c.onlyBooks + c.noGstin) ? 'mismatch' : 'match'),
  ].join('');

  const probableCols = pairCols.slice(0, 8).concat([{ label: 'Note', get: e => (e.amountsAgree ? '' : 'Amounts differ — ') + (e.note || 'No GSTIN in books') }]);

  const html = `
    <div class="summary-grid">${cards}</div>
    ${section('Booked twice in your books', 'bad', 'The same supplier invoice (same number and amount) is in your books more than once. The first entry matched GSTR-2B; these extra vouchers would claim the ITC twice. Delete them in Tally.',
      [{ label: 'Extra voucher', get: d => d.books.voucherNo }, { label: 'Party', get: d => d.books.party }, { label: 'Invoice', get: d => d.books.no },
       { label: 'Date', get: d => dmy(d.books.date) }, { label: 'Tax', num: true, get: d => taxOf(d.books) },
       { label: 'Already booked as voucher', get: d => `${d.first.voucherNo} (${d.first.party})` }], r.bookedTwice || [])}
    ${r.duplicatesInBooks.length && !(r.bookedTwice || []).length ? `<div class="notice notice-warn" style="margin-bottom:16px"><span>${r.duplicatesInBooks.length} supplier invoice${r.duplicatesInBooks.length === 1 ? ' appears' : 's appear'} more than once in your books (${esc(r.duplicatesInBooks.map(l => l[0].no).join(', '))}) — the extra entries are listed under "In books, not in 2B".</span></div>` : ''}
    ${section('Amount differs', 'bad', 'Same supplier and invoice in both, but the tax amounts disagree. The difference is books − 2B.', pairCols, r.differs)}
    ${section('Probable matches — no GSTIN in books', 'warn', 'These vouchers have no usable GSTIN, so they were matched on invoice number and amount only. Please confirm each, then add the GSTIN to the party in Tally.', probableCols, r.probable)}
    ${section('Possible matches — invoice number differs', 'warn', 'Same supplier, same amount, close dates, but the invoice number is typed differently.', pairCols, r.possible)}
    ${typeof only2bSectionHTML === 'function'
      ? only2bSectionHTML(r)
      : section('In GSTR-2B, not in books', 'bad', 'The supplier reported these but they are not in your purchase register. ITC can usually only be claimed once they are booked.', only2bCols, r.only2b)}
    ${suppliersSectionHTML(r)}
    ${section('In books, not in GSTR-2B', 'bad', 'In your purchase register with a GSTIN, but the supplier has not reported them (yet).', onlyBooksCols, r.onlyBooks)}
    ${section('In books, no usable GSTIN, no match', 'warn', 'No valid GSTIN to match on and nothing in 2B fits. May be unregistered suppliers, or a missing GSTIN.', onlyBooksCols, r.noGstin)}
    ${section('Matched', 'ok', c.smartMatched ? `${c.smartMatched} matched by smart matching: same GSTIN, same amounts, close dates, and the same invoice number written with an extra prefix or suffix (shown in the Note column).` : '',
      pairCols.concat([{ label: 'Note', get: e => (e.smart ? 'Smart match' : '') }]), r.matched, { open: false })}
    <div style="margin-top:14px"><button type="button" class="btn-reset" id="btn-books-csv">Download exceptions (CSV)</button></div>`;

  const out = document.getElementById('books-results');
  out.innerHTML = html;
  out.style.display = 'block';
  document.getElementById('btn-books-csv').addEventListener('click', downloadBooksCSV);
  const sup = document.getElementById('btn-suppliers-csv');
  if (sup) sup.addEventListener('click', downloadSuppliersCSV);
  if (typeof bindOnly2b === 'function') bindOnly2b(r);
}

// ── Suppliers to chase ──────────────────────────────────────────────────────
// "In books, not in 2B" grouped by supplier, largest ITC at risk first: the
// suppliers who haven't filed (or filed wrongly) and should be followed up.

function suppliersSectionHTML(r) {
  const list = BooksRecon.suppliersToChase(r);
  if (!list.length) return '';
  const total = list.reduce((s, g) => s + g.itc, 0);
  const rows = list.map(g => `<tr>
    <td>${esc(g.party || '—')}</td><td>${esc(g.ctin || 'No GSTIN in books')}</td>
    <td class="num">${g.count}</td><td class="num">${money(g.taxable)}</td><td class="num">${money(g.itc)}</td>
    <td>${esc(dmy(g.lastDate))}</td><td class="sup-inv">${esc(g.invoices.slice(0, 4).join(', '))}${g.invoices.length > 4 ? ` +${g.invoices.length - 4} more` : ''}</td></tr>`).join('');
  return `<details class="table-wrap bk-details" open>
    <summary>Suppliers to chase<span class="bk-badge bad">${list.length}</span></summary>
    <p class="bk-note" style="padding:0 14px">Suppliers whose invoices are in your books but not in GSTR-2B, largest ITC at risk first — ₹${money(total)} in all. Ask them to file (or correct) their GSTR-1; the credit can't be claimed until they do.</p>
    <div style="overflow-x:auto"><table class="bk-table"><thead><tr>
      <th>Supplier</th><th>GSTIN</th><th class="num">Invoices</th><th class="num">Taxable</th><th class="num">ITC at risk</th><th>Latest invoice</th><th>Invoice numbers</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <div style="padding:10px 14px"><button type="button" class="btn-reset" id="btn-suppliers-csv">Download supplier list (CSV)</button></div>
  </details>`;
}

function downloadSuppliersCSV() {
  if (!booksResult) return;
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Supplier', 'GSTIN', 'Invoices', 'Taxable', 'ITC at risk', 'Latest invoice', 'Invoice numbers'].map(q).join(',')];
  BooksRecon.suppliersToChase(booksResult).forEach(g => lines.push([g.party, g.ctin, g.count, g.taxable, g.itc, dmy(g.lastDate), g.invoices.join(' | ')].map(q).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'Suppliers_to_chase.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadBooksCSV() {
  if (!booksResult) return;
  const r = booksResult;
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Status', 'Supplier', 'GSTIN', 'Invoice (books)', 'Invoice (2B)', 'Date', 'Tax books', 'Tax 2B', 'Difference', 'Note'].map(q).join(',')];
  const pair = (status, e) => lines.push([status, e.twoB.party || e.books.party, e.twoB.ctin || e.books.ctin, e.books.no, e.twoB.no, dmy(e.twoB.date), taxOf(e.books), taxOf(e.twoB), e.diff.tax, e.note].map(q).join(','));
  r.differs.forEach(e => pair('Amount differs', e));
  r.probable.forEach(e => pair('Probable (no GSTIN in books)', e));
  r.possible.forEach(e => pair('Possible (invoice no. differs)', e));
  r.only2b.forEach(k => lines.push(['In 2B, not in books', k.party, k.ctin, '', k.no, dmy(k.date), '', taxOf(k), '', ''].map(q).join(',')));
  r.onlyBooks.concat(r.noGstin).forEach(b => lines.push(['In books, not in 2B', b.party, b.ctin || b.gstinRaw, b.no, '', dmy(b.date), taxOf(b), '', '', b.ctin ? '' : 'No usable GSTIN'].map(q).join(',')));
  (r.bookedTwice || []).forEach(d => lines.push(['Booked twice in books', d.books.party, d.books.ctin || d.books.gstinRaw, d.books.no, '', dmy(d.books.date), taxOf(d.books), '', '', `Extra voucher ${d.books.voucherNo}; first booked as voucher ${d.first.voucherNo}`].map(q).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'GSTR2B_vs_books_exceptions.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Wiring ──────────────────────────────────────────────────────────────────

// opts.keepNotices: the caller has just put notices on screen (e.g. the Tally
// import) and wants them to survive the comparison.
function runBooksRecon(opts) {
  const keep = !!(opts && opts.keepNotices === true);
  if (!keep) {
    document.getElementById('books-notices').innerHTML = '';
    if (booksLoaded && !booksRows.length) {
      booksNotice('info', 'There are no purchase entries in the register, so every GSTR-2B invoice is shown as missing from your books. If you expected entries, check the right company and dates were loaded.');
    }
  }
  try {
    const raw2b = Object.values(files['2b']).map(f => f.data);
    booksResult = BooksRecon.reconcile(raw2b, booksRows);
    renderBooksResult(booksResult);
  } catch (err) {
    booksNotice('error', 'Reconciliation with books failed: ' + err.message);
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('file-books').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    document.getElementById('books-notices').innerHTML = '';
    try {
      const text = await file.text();
      const rows = /\.json$/i.test(file.name) ? JSON.parse(text) : booksRowsFromCSV(text);
      if (!Array.isArray(rows) || !rows.length) throw new Error('No purchase entries found in the file.');
      setBooks(rows, file.name);
      const noGstin = rows.filter(r => !BooksRecon.cleanGstin(r.gstin)).length;
      if (noGstin) booksNotice('warn', `${noGstin} of ${rows.length} entries have no valid GSTIN. They'll only be matched on invoice number + amount and marked "probable".`);
    } catch (err) {
      booksNotice('error', `Could not read "${file.name}": ${err.message}`);
    }
  });

  document.getElementById('btn-books-run').addEventListener('click', () => runBooksRecon());

  document.getElementById('btn-books-template').addEventListener('click', () => {
    const sample = [BOOKS_TEMPLATE_HEADERS, ['05-04-2025', 'P-001', 'INV/0012', 'Alpha Traders', '29AAAAA1111A1Z5', '10000', '0', '900', '900', '0', '11800', 'Purchase'],
      ['25-04-2025', 'PR-001', 'CN-5', 'Alpha Traders', '29AAAAA1111A1Z5', '1000', '0', '90', '90', '0', '1180', 'Purchase Return']];
    const blob = new Blob([sample.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'purchase_register_template.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // The GSTR browser extension can push purchase entries straight in (e.g.
  // read from Tally). Only same-window messages of one known type are accepted.
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.type !== 'GSTR_BOOKS_ROWS' || !Array.isArray(e.data.rows)) return;
    setBooks(e.data.rows, e.data.label || 'Tally', { company: e.data.company, companyGstins: e.data.companyGstins });
  });

  refreshBooksControls();
});

// Keep the Run button in step with the 2B files loaded above by hooking the
// app's own "chips changed" step — it runs after every add, replace or remove
// (including once a large file has finished parsing), so no timers needed.
(function () {
  const original = renderFileChips;
  renderFileChips = function (key) {
    original(key);
    if (document.getElementById('btn-books-run')) refreshBooksControls();
  };
})();
