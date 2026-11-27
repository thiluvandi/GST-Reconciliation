/**
 * sales-ui.js
 * GSTR-1 against the sales in Tally: one click reads the sales vouchers for
 * the months of the GSTR-1 files loaded above (through the GSTR extension,
 * like the purchase import) and compares
 *   - invoice by invoice where GSTR-1 has invoices (B2B, B2CL, exports,
 *     credit/debit notes), with the same matching as purchases;
 *   - month by month on totals, split registered (B2B) / unregistered (B2C):
 *     the only check possible for B2CS and for "totals only" downloads.
 *
 * Relies on globals from app.js (files), books-ui.js (esc, money, dmy, taxOf,
 * section) and tally-ui.js (ensureExtension, tallyRequest, versionAtLeast,
 * ext, isoMonthOf).
 */

const SALES_EXT_VERSION = '1.13.0';
let salesResult = null;

function salesNotice(type, text) {
  const item = document.createElement('div');
  item.className = 'notice notice-' + type;
  item.innerHTML = `<span>${esc(text)}</span><button type="button" class="notice-x" aria-label="Dismiss">&times;</button>`;
  item.querySelector('.notice-x').addEventListener('click', () => item.remove());
  document.getElementById('sales-notices').appendChild(item);
}

/** The months of the GSTR-1 files loaded above, as YYYY-MM, oldest first. */
function r1Months() {
  return Object.keys(files.r1 || {}).map(isoMonthOf).filter(Boolean).sort();
}

function refreshSalesControls() {
  const hint = document.getElementById('sales-hint');
  const btn = document.getElementById('btn-sales-import');
  if (!hint) return;
  const m = r1Months();
  btn.disabled = !m.length;
  hint.textContent = m.length
    ? `${m.length} GSTR-1 month${m.length === 1 ? '' : 's'} loaded (${m[0]}${m.length > 1 ? ' to ' + m[m.length - 1] : ''}) — import the sales for ${m.length === 1 ? 'that month' : 'those months'} from Tally.`
    : 'Load GSTR-1 above, then import your sales from Tally.';
}

async function importSalesFromTally() {
  const btn = document.getElementById('btn-sales-import');
  document.getElementById('sales-notices').innerHTML = '';
  const m = r1Months();
  if (!m.length) return salesNotice('error', 'Load at least one GSTR-1 file above first.');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Reading sales from Tally…';
  try {
    await ensureExtension();
    if (!versionAtLeast(ext.version, SALES_EXT_VERSION)) {
      throw new Error(`Reading sales needs the GSTR extension v${SALES_EXT_VERSION} or later (you have v${ext.version}). Update or reload it, then refresh this page.`);
    }
    const data = dropRepeatedTallyRows(await tallyRequest('fetchSales', { from: m[0], to: m[m.length - 1] }, 10 * 60 * 1000));
    const company = (data.companies || [])[0] || '';
    const raw = Object.values(files.r1).map(f => f.data);
    salesResult = BooksRecon.reconcileSales(raw, data.rows);
    salesResult.company = company;
    const mine = [...new Set(raw.map(d => String((d && (d.gstin || (d.data && d.data.gstin))) || '').toUpperCase()).filter(Boolean))];
    if (mine.length && (data.companyGstins || []).length && !data.companyGstins.some(g => mine.includes(g))) {
      salesNotice('warn', `Tally's open company (GSTIN ${data.companyGstins.join(', ')}) does not match the GSTR-1 files (GSTIN ${mine.join(', ')}). Make sure the right company is open.`);
    }
    if (salesResult.totalsOnlyMonths.length) {
      salesNotice('info', `GSTR-1 for ${salesResult.totalsOnlyMonths.join(', ')} is a totals-only download, so ${salesResult.totalsOnlyMonths.length === 1 ? 'that month is' : 'those months are'} compared on totals. Download the full GSTR-1 JSON with the extension to check invoice by invoice.`);
    }
    renderSalesResult(salesResult);
  } catch (err) {
    salesNotice('error', err.message);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

const salesPairCols = [
  { label: 'Customer', get: e => e.books.party },
  { label: 'GSTIN', get: e => e.twoB.ctin || e.books.ctin },
  { label: 'Invoice (books)', get: e => e.books.no },
  { label: 'Invoice (GSTR-1)', get: e => e.twoB.no },
  { label: 'Date', get: e => dmy(e.twoB.date) },
  { label: 'Tax books', num: true, get: e => taxOf(e.books) },
  { label: 'Tax GSTR-1', num: true, get: e => taxOf(e.twoB) },
  { label: 'Difference', num: true, neg: true, get: e => e.diff.tax },
];
const r1OnlyCols = [
  { label: 'Section', get: k => k.section }, { label: 'GSTIN', get: k => k.ctin || '—' }, { label: 'Invoice', get: k => k.no },
  { label: 'Date', get: k => dmy(k.date) }, { label: 'Taxable', num: true, get: k => k.taxable }, { label: 'Tax', num: true, get: k => taxOf(k) },
];
const salesBooksCols = [
  { label: 'Voucher', get: b => b.voucherNo }, { label: 'Customer', get: b => b.party }, { label: 'GSTIN', get: b => b.ctin || '—' },
  { label: 'Date', get: b => dmy(b.date) }, { label: 'Taxable', num: true, get: b => b.taxable }, { label: 'Tax', num: true, get: b => taxOf(b) },
];

function monthTableHTML(months) {
  // One row per part (B2B, B2C, Total) under each month: seven columns, no sideways scrolling.
  const tol = BooksRecon.AMOUNT_TOLERANCE;
  const line = (m, part, label, first) => {
    const a = m.r1[part], b = m.books[part];
    const ok = Math.abs(a.taxable - b.taxable) <= tol && Math.abs(a.tax - b.tax) <= tol;
    return `<tr class="${part === 'total' ? 'sm-total' : ''}">
      <td>${first ? `<b>${esc(m.label)}</b>${m.totalsOnly ? ' <span class="bk-badge warn">totals only</span>' : ''}` : ''}</td><td>${label}</td>
      <td class="num">${money(a.taxable)}</td><td class="num ${Math.abs(a.taxable - b.taxable) <= tol ? '' : 'neg'}">${money(b.taxable)}</td>
      <td class="num">${money(a.tax)}</td><td class="num ${Math.abs(a.tax - b.tax) <= tol ? '' : 'neg'}">${money(b.tax)}</td>
      <td>${part === 'total' ? (m.agrees ? '<span class="bk-badge ok">Agrees</span>' : '<span class="bk-badge bad">Check</span>') : (ok ? '' : '<span class="sm-diff">differs</span>')}</td></tr>`;
  };
  const rows = months.map(m => line(m, 'b2b', 'B2B (registered)', true) + line(m, 'b2c', 'B2C (unregistered)') + line(m, 'total', 'Total')).join('');
  return `<details class="table-wrap bk-details" open>
    <summary>Month by month: GSTR-1 vs books<span class="bk-badge ${months.every(m => m.agrees) ? 'ok' : 'bad'}">${months.filter(m => m.agrees).length}/${months.length}</span></summary>
    <p class="bk-note" style="padding:0 14px">Sales to registered customers (B2B) and unregistered ones (B2C — GSTR-1 holds small B2C sales only as totals). Book figures in red differ from GSTR-1 by more than ₹1.</p>
    <div style="overflow-x:auto"><table class="bk-table sm-table"><thead>
      <tr><th>Month</th><th></th><th class="num">Taxable · GSTR-1</th><th class="num">Taxable · Books</th><th class="num">Tax · GSTR-1</th><th class="num">Tax · Books</th><th></th></tr>
    </thead><tbody>${rows}</tbody></table></div>
  </details>`;
}

function renderSalesResult(s) {
  const r = s.invoices, c = r.summary.counts;
  const agree = s.months.filter(m => m.agrees).length;
  const card = (label, value, sub, cls = '') =>
    `<div class="summary-card"><div class="sc-label">${esc(label)}</div><div class="sc-value ${cls}">${value}</div><div class="sc-sub">${esc(sub)}</div></div>`;
  const invoiceLevel = s.months.some(m => !m.totalsOnly);
  const cards = [
    card('Months that agree', `${agree}/${s.months.length}`, 'GSTR-1 vs books totals', agree === s.months.length ? 'match' : 'mismatch'),
    invoiceLevel ? card('Invoices matched', c.matched, `${c.smartMatched ? c.smartMatched + ' by smart matching' : 'B2B, B2CL, exports, notes'}`, 'match') : '',
    invoiceLevel ? card('Amount differs', c.differs, 'same invoice, different tax', c.differs ? 'mismatch' : 'match') : '',
    invoiceLevel ? card('In GSTR-1, not in books', c.only2b, 'reported but not in Tally', c.only2b ? 'mismatch' : 'match') : '',
    invoiceLevel ? card('In books, not in GSTR-1', c.onlyBooks, 'B2B sales not reported', c.onlyBooks ? 'mismatch' : 'match') : '',
  ].join('');
  const out = document.getElementById('sales-results');
  out.innerHTML = `
    <div class="summary-grid">${cards}</div>
    ${monthTableHTML(s.months)}
    ${invoiceLevel ? `
      ${section('Amount differs', 'bad', 'Same customer and invoice in GSTR-1 and books, but the tax disagrees. Difference is books − GSTR-1.', salesPairCols, r.differs)}
      ${section('Possible matches — invoice number differs', 'warn', 'Same customer, same amount, close dates, but the invoice number differs.', salesPairCols, r.possible)}
      ${section('In books, not in GSTR-1', 'bad', 'Sales to registered customers in your books that are not in GSTR-1: the customer cannot take this credit until it is reported (amend in the next GSTR-1).', salesBooksCols, r.onlyBooks)}
      ${section('In GSTR-1, not in books', 'bad', 'Reported in GSTR-1 but not found in your sales books.', r1OnlyCols, r.only2b)}
      ${section('Booked twice in your books', 'bad', 'The same sales invoice is in your books more than once.', [{ label: 'Extra voucher', get: d => d.books.voucherNo }, { label: 'Customer', get: d => d.books.party }, { label: 'Date', get: d => dmy(d.books.date) }, { label: 'Tax', num: true, get: d => taxOf(d.books) }, { label: 'First booked as', get: d => d.first.voucherNo }], r.bookedTwice || [])}
      ${section('Matched', 'ok', '', salesPairCols.concat([{ label: 'Note', get: e => (e.smart ? 'Smart match' : '') }]), r.matched, { open: false })}` : ''}
    <div style="margin-top:14px"><button type="button" class="btn-reset" id="btn-sales-csv">Download exceptions (CSV)</button></div>`;
  out.style.display = 'block';
  document.getElementById('btn-sales-csv').addEventListener('click', downloadSalesCSV);
}

function downloadSalesCSV() {
  if (!salesResult) return;
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Status', 'Month / Customer', 'GSTIN', 'Invoice (books)', 'Invoice (GSTR-1)', 'Date', 'Taxable books', 'Taxable GSTR-1', 'Tax books', 'Tax GSTR-1'].map(q).join(',')];
  salesResult.months.filter(m => !m.agrees).forEach(m => lines.push(['Month differs', m.label, '', '', '', '', m.books.total.taxable, m.r1.total.taxable, m.books.total.tax, m.r1.total.tax].map(q).join(',')));
  const r = salesResult.invoices;
  r.differs.forEach(e => lines.push(['Amount differs', e.books.party, e.twoB.ctin, e.books.no, e.twoB.no, dmy(e.twoB.date), e.books.taxable, e.twoB.taxable, taxOf(e.books), taxOf(e.twoB)].map(q).join(',')));
  r.onlyBooks.forEach(b => lines.push(['In books, not in GSTR-1', b.party, b.ctin, b.no, '', dmy(b.date), b.taxable, '', taxOf(b), ''].map(q).join(',')));
  r.only2b.forEach(k => lines.push(['In GSTR-1, not in books', k.section, k.ctin, '', k.no, dmy(k.date), '', k.taxable, '', taxOf(k)].map(q).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'GSTR1_vs_sales_books_exceptions.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-sales-import');
  if (!btn) return;
  btn.addEventListener('click', importSalesFromTally);
  refreshSalesControls();
});

// Keep the hint in step with the GSTR-1 files loaded above.
(function () {
  const original = refreshBooksControls;
  refreshBooksControls = function () {
    original();
    refreshSalesControls();
  };
})();
