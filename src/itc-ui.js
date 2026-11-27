/**
 * itc-ui.js
 * ITC month by month: what GSTR-3B claimed (table 4A, reverse charge left out)
 * against what GSTR-2B made available and what the purchase books in Tally
 * hold. 3B vs 2B shows as soon as both are loaded above; "Import purchases
 * from Tally" adds the books column (read only, through the GSTR extension).
 *
 * Relies on globals from app.js (files), books-ui.js (esc, money) and
 * tally-ui.js (ensureExtension, tallyRequest, versionAtLeast, ext,
 * isoMonthOf, MIN_EXT_VERSION).
 */

let itcBooksRows = null;      // purchase rows read from Tally for the ITC card
let itcBooksSpan = '';        // "from..to" those rows cover
let itcBooksCompany = '';
let itcResult = null;
const ITC_HEADS = [['igst', 'IGST'], ['cgst', 'CGST'], ['sgst', 'SGST'], ['cess', 'Cess']];

function itcNotice(type, text) {
  const item = document.createElement('div');
  item.className = 'notice notice-' + type;
  item.innerHTML = `<span>${esc(text)}</span><button type="button" class="notice-x" aria-label="Dismiss">&times;</button>`;
  item.querySelector('.notice-x').addEventListener('click', () => item.remove());
  document.getElementById('itc-notices').appendChild(item);
}

/** Months of the 3B and 2B files loaded above, as YYYY-MM, oldest first. */
function itcMonths() {
  return [...new Set(Object.keys(files['3b'] || {}).concat(Object.keys(files['2b'] || {})).map(isoMonthOf).filter(Boolean))].sort();
}

function refreshItcControls() {
  const hint = document.getElementById('itc-hint');
  const btn = document.getElementById('btn-itc-import');
  if (!hint) return;
  const n3 = Object.keys(files['3b'] || {}).length, n2 = Object.keys(files['2b'] || {}).length;
  const m = itcMonths();
  btn.disabled = !n3;
  if (!n3) hint.textContent = 'Load GSTR-3B (and GSTR-2B) above, then import your purchases from Tally.';
  else hint.textContent = `${n3} GSTR-3B and ${n2} GSTR-2B month${n2 === 1 ? '' : 's'} loaded (${m[0]}${m.length > 1 ? ' to ' + m[m.length - 1] : ''})` +
    (itcBooksRows ? ` — books from Tally for ${itcBooksSpan}.` : ' — import purchases from Tally to add your books.');
  renderItc();
}

async function importItcBooks() {
  const btn = document.getElementById('btn-itc-import');
  document.getElementById('itc-notices').innerHTML = '';
  const m = itcMonths();
  if (!m.length) return itcNotice('error', 'Load at least one GSTR-3B file above first.');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Reading purchases from Tally…';
  try {
    await ensureExtension();
    if (!versionAtLeast(ext.version, MIN_EXT_VERSION)) {
      throw new Error(`The GSTR extension (v${ext.version}) is too old — update to v${MIN_EXT_VERSION} or later.`);
    }
    const from = m[0], to = m[m.length - 1];
    const data = dropRepeatedTallyRows(await tallyRequest('fetchBooks', { from, to }, 10 * 60 * 1000));
    itcBooksRows = data.rows || [];
    itcBooksSpan = from === to ? from : `${from} to ${to}`;
    itcBooksCompany = (data.companies || [])[0] || '';
    const mine = [...new Set(Object.values(files['3b']).concat(Object.values(files['2b'])).map(f => {
      const d = f.data && (f.data.data || f.data);
      return String((d && d.gstin) || '').toUpperCase();
    }).filter(Boolean))];
    if (mine.length && (data.companyGstins || []).length && !data.companyGstins.some(g => mine.includes(g))) {
      itcNotice('warn', `Tally's open company (GSTIN ${data.companyGstins.join(', ')}) does not match the GSTR files (GSTIN ${mine.join(', ')}). Make sure the right company is open.`);
    }
    if (data.stats && data.stats.rcmOnly) {
      itcNotice('info', `${data.stats.rcmOnly} reverse-charge entr${data.stats.rcmOnly === 1 ? 'y was' : 'ies were'} left out of the books, as reverse charge is left out of the 3B figure too.`);
    }
  } catch (err) {
    itcNotice('error', err.message);
  } finally {
    btn.disabled = false; btn.textContent = label;
    refreshItcControls();
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

const tot = t => (t ? Math.round((t.igst + t.cgst + t.sgst + t.cess) * 100) / 100 : null);
const cell = (v, cls = '') => `<td class="num ${cls}">${v === null || v === undefined ? '—' : money(v)}</td>`;
const tolOk = v => v === null || Math.abs(v) <= BooksRecon.AMOUNT_TOLERANCE;

/** Words for the month's state, from the total differences. */
function itcStatus(m) {
  const d2 = m.diff2b ? tot(m.diff2b) : null, db = m.diffBooks ? tot(m.diffBooks) : null;
  const out = [];
  if (!m.claimed) out.push('<span class="bk-badge warn">no 3B</span>');
  if (d2 !== null) {
    if (d2 > BooksRecon.AMOUNT_TOLERANCE) out.push(`<span class="bk-badge bad">₹${money(d2)} more than 2B</span>`);
    else if (d2 < -BooksRecon.AMOUNT_TOLERANCE) out.push(`<span class="bk-badge warn">₹${money(-d2)} of 2B not claimed</span>`);
  }
  if (db !== null) {
    if (db > BooksRecon.AMOUNT_TOLERANCE) out.push(`<span class="bk-badge bad">₹${money(db)} more than books</span>`);
    else if (db < -BooksRecon.AMOUNT_TOLERANCE) out.push(`<span class="bk-badge warn">₹${money(-db)} in books not claimed</span>`);
  }
  // Totals can agree while the heads don't (IGST claimed as CGST + SGST).
  if (!out.length && (!m.agrees2b || !m.agreesBooks)) out.push('<span class="bk-badge bad">tax heads differ</span>');
  if (!out.length && m.claimed) out.push('<span class="bk-badge ok">Agrees</span>');
  return `<div style="display:flex;flex-direction:column;align-items:flex-start;gap:4px">${out.join('')}</div>`;
}

function itcRowsHTML(m, label, bold) {
  const show = ITC_HEADS.filter(([h]) => h !== 'cess' || [m.claimed, m.available, m.books].some(t => t && Math.abs(t.cess) > 0.005));
  const lines = show.map(([h, name], i) => {
    const g = t => (t ? t[h] : null);
    const d2 = g(m.diff2b), db = g(m.diffBooks);
    return `<tr><td>${i === 0 ? (bold ? `<b>${esc(label)}</b>` : esc(label)) : ''}</td><td>${name}</td>
      ${cell(g(m.claimed))}${cell(g(m.available))}${cell(g(m.books))}
      ${cell(d2, tolOk(d2) ? '' : 'neg')}${cell(db, tolOk(db) ? '' : 'neg')}<td></td></tr>`;
  }).join('');
  const d2 = m.diff2b ? tot(m.diff2b) : null, db = m.diffBooks ? tot(m.diffBooks) : null;
  return lines + `<tr class="sm-total"><td></td><td>Total</td>
    ${cell(tot(m.claimed))}${cell(tot(m.available))}${cell(tot(m.books))}
    ${cell(d2, tolOk(d2) ? '' : 'neg')}${cell(db, tolOk(db) ? '' : 'neg')}<td>${itcStatus(m)}</td></tr>`;
}

function itcExtrasHTML(r) {
  const rows = r.months.filter(m => [m.rcm3b, m.reversed, m.rcm2b, m.notAvailable2b].some(t => t && Math.abs(tot(t)) > 0.005));
  if (!rows.length) return '';
  const body = rows.map(m => `<tr><td><b>${esc(m.label)}</b></td>
    ${cell(m.rcm3b && tot(m.rcm3b))}${cell(m.reversed && tot(m.reversed))}${cell(m.net3b && tot(m.net3b))}
    ${cell(m.rcm2b && tot(m.rcm2b))}${cell(m.notAvailable2b && tot(m.notAvailable2b))}</tr>`).join('');
  return `<details class="table-wrap bk-details">
    <summary>Not in the comparison: reverse charge, reversals, ITC not available<span class="bk-badge warn">${rows.length}</span></summary>
    <p class="bk-note" style="padding:0 14px">Reverse charge is paid in cash and never shows in GSTR-2B, so it is left out above. Reversals (3B table 4B) are shown here with the net ITC 3B ends up with. "Not available" is ITC GSTR-2B lists but marks ineligible (e.g. place of supply, time limit).</p>
    <div style="overflow-x:auto"><table class="bk-table sm-table"><thead><tr><th>Month</th>
      <th class="num">Reverse charge · 3B</th><th class="num">Reversed · 3B 4B</th><th class="num">Net ITC · 3B</th>
      <th class="num">Reverse charge · 2B</th><th class="num">Not available · 2B</th></tr></thead><tbody>${body}</tbody></table></div>
  </details>`;
}

function renderItc() {
  const out = document.getElementById('itc-results');
  if (!out) return;
  const raw3 = Object.values(files['3b'] || {}).map(f => f.data);
  const raw2 = Object.values(files['2b'] || {}).map(f => f.data);
  if (!raw3.length) { out.style.display = 'none'; out.innerHTML = ''; itcResult = null; return; }
  const r = itcResult = BooksRecon.reconcileITC(raw3, raw2, itcBooksRows);
  if (!r.months.length) { out.style.display = 'none'; return; }

  const y = r.year;
  const card = (label, value, sub, cls = '') =>
    `<div class="summary-card"><div class="sc-label">${esc(label)}</div><div class="sc-value ${cls}">${value}</div><div class="sc-sub">${esc(sub)}</div></div>`;
  const withBoth = r.months.filter(m => m.claimed && m.available);
  const ok2b = withBoth.filter(m => m.agrees2b).length;
  const y2 = y.diff2b ? tot(y.diff2b) : null, yb = y.diffBooks ? tot(y.diffBooks) : null;
  const diffCard = (label, v, more, less) => (v === null ? '' : card(label, '₹' + money(Math.abs(v)),
    tolOk(v) ? 'agrees for the period' : (v > 0 ? more : less), tolOk(v) ? 'match' : 'mismatch'));
  const cards = [
    card('ITC claimed in 3B', '₹' + money(tot(y.claimed) || 0), 'table 4A, without reverse charge'),
    withBoth.length ? card('Months 3B agrees with 2B', `${ok2b}/${withBoth.length}`, 'every tax head within ₹1', ok2b === withBoth.length ? 'match' : 'mismatch') : '',
    diffCard('3B vs 2B', y2, 'claimed more than 2B shows', 'in 2B but not claimed'),
    diffCard('3B vs books', yb, 'claimed more than the books hold', 'in books but not claimed'),
  ].join('');

  const rows = r.months.map(m => itcRowsHTML(m, m.label, true)).join('') +
    (y.months.length > 1 ? itcRowsHTML(y, `Total (${y.months.length} months of 3B)`, true) : '');
  const notes = [];
  if (r.missing2b.length) notes.push(`No GSTR-2B loaded for ${r.missing2b.join(', ')}.`);
  if (r.missing3b.length) notes.push(`No GSTR-3B loaded for ${r.missing3b.join(', ')}.`);
  if (!itcBooksRows) notes.push('Books: click “Import purchases from Tally” to fill this column.');

  out.innerHTML = `
    <div class="summary-grid">${cards}</div>
    <details class="table-wrap bk-details" open>
      <summary>Month by month: 3B claimed vs 2B vs books</summary>
      <p class="bk-note" style="padding:0 14px">3B is table 4A without reverse charge (other ITC, imports, ISD). 2B is the ITC it marks available, credit notes taken off. Books are purchases with input tax in Tally${itcBooksCompany ? ' (' + esc(itcBooksCompany) + ')' : ''}, by voucher date. Differences are 3B minus the other figure; red means more than ₹1 apart. ${esc(notes.join(' '))}</p>
      <div style="overflow-x:auto"><table class="bk-table sm-table"><thead>
        <tr><th>Month</th><th></th><th class="num">3B claimed</th><th class="num">2B available</th><th class="num">Books</th><th class="num">3B − 2B</th><th class="num">3B − Books</th><th></th></tr>
      </thead><tbody>${rows}</tbody></table></div>
    </details>
    ${itcExtrasHTML(r)}
    <div style="margin-top:14px"><button type="button" class="btn-reset" id="btn-itc-csv">Download ITC comparison (CSV)</button></div>`;
  out.style.display = 'block';
  document.getElementById('btn-itc-csv').addEventListener('click', downloadItcCSV);
}

function downloadItcCSV() {
  if (!itcResult) return;
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const v = (t, h) => (t ? t[h] : '');
  const lines = [['Month', 'Tax', '3B claimed', '2B available', 'Books', '3B - 2B', '3B - Books', '3B reverse charge', '3B reversed', '3B net ITC'].map(q).join(',')];
  const add = (label, m) => ITC_HEADS.concat([['total', 'Total']]).forEach(([h, name]) => {
    const g = t => (!t ? '' : h === 'total' ? tot(t) : t[h]);
    lines.push([label, name, g(m.claimed), g(m.available), g(m.books), g(m.diff2b), g(m.diffBooks), g(m.rcm3b), g(m.reversed), g(m.net3b)].map(q).join(','));
  });
  itcResult.months.forEach(m => add(m.label, m));
  if (itcResult.year.months.length > 1) add('Total of 3B months', itcResult.year);
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'ITC_3B_vs_2B_vs_books.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-itc-import');
  if (!btn) return;
  btn.addEventListener('click', importItcBooks);
  refreshItcControls();
});

// Redraw whenever the 3B / 2B files above change.
(function () {
  const original = refreshBooksControls;
  refreshBooksControls = function () {
    original();
    refreshItcControls();
  };
})();
