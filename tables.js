/**
 * tables.js
 * DOM table rendering for the GST reconciliation output.
 */

/**
 * Format a number in Indian number system with 2 decimal places.
 * Returns '–' for zero or null.
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
  if (n === 0 || n == null) return '–';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * Format a difference value with a leading + or – sign.
 * Returns '–' if within ₹1 rounding tolerance.
 * @param {number} n
 * @returns {string}
 */
function fmtDiff(n) {
  if (Math.abs(n) < 1) return '–';
  const sign = n > 0 ? '+' : '';
  return sign + new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * Build thead with given column labels (first col left-aligned, rest right).
 */
function buildThead(table, headers) {
  const thead = table.createTHead();
  const row   = thead.insertRow();
  headers.forEach((h, i) => {
    const th       = document.createElement('th');
    th.textContent = h;
    row.appendChild(th);
  });
}

/**
 * Render sales table (Taxable Value + CGST + SGST + IGST + Total).
 * Used for both GSTR-1 and GSTR-3B sales sections.
 *
 * @param {string}   tableId  - DOM id of <table>
 * @param {Object}   monthData - { [month]: { taxable, cgst, sgst, igst } }
 * @param {string[]} months   - ordered list of month labels
 */
function buildSalesTable(tableId, monthData, months) {
  const tbl = document.getElementById(tableId);
  tbl.innerHTML = '';
  buildThead(tbl, ['Month', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total']);

  const tbody = tbl.createTBody();
  let tTax = 0, tCgst = 0, tSgst = 0, tIgst = 0;

  months.forEach(m => {
    const d = monthData[m] || { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    const total = d.taxable + d.cgst + d.sgst + d.igst;
    tTax += d.taxable; tCgst += d.cgst; tSgst += d.sgst; tIgst += d.igst;

    const tr = tbody.insertRow();
    [m, fmt(d.taxable), fmt(d.cgst), fmt(d.sgst), fmt(d.igst), fmt(total)]
      .forEach(v => { tr.insertCell().textContent = v; });
  });

  // Total row
  const ttr = tbody.insertRow();
  ttr.classList.add('total-row');
  ['Total', fmt(tTax), fmt(tCgst), fmt(tSgst), fmt(tIgst), fmt(tTax + tCgst + tSgst + tIgst)]
    .forEach(v => { ttr.insertCell().textContent = v; });
}

/**
 * Render GSTR-2B ITC table (CGST + SGST + IGST + Total ITC).
 *
 * @param {string}   tableId
 * @param {Object}   monthData - { [month]: { cgst, sgst, igst } }
 * @param {string[]} months
 */
function build2BTable(tableId, monthData, months) {
  const tbl = document.getElementById(tableId);
  tbl.innerHTML = '';
  buildThead(tbl, ['Month', 'CGST', 'SGST', 'IGST', 'Total ITC']);

  const tbody = tbl.createTBody();
  let tC = 0, tS = 0, tI = 0;

  months.forEach(m => {
    const d = monthData[m] || { cgst: 0, sgst: 0, igst: 0 };
    tC += d.cgst; tS += d.sgst; tI += d.igst;

    const tr = tbody.insertRow();
    [m, fmt(d.cgst), fmt(d.sgst), fmt(d.igst), fmt(d.cgst + d.sgst + d.igst)]
      .forEach(v => { tr.insertCell().textContent = v; });
  });

  const ttr = tbody.insertRow();
  ttr.classList.add('total-row');
  ['Total', fmt(tC), fmt(tS), fmt(tI), fmt(tC + tS + tI)]
    .forEach(v => { ttr.insertCell().textContent = v; });
}

/**
 * Render Sales reconciliation table: GSTR-1 tax vs GSTR-3B tax.
 *
 * @param {string}   tableId
 * @param {Object}   g1  - parsed GSTR-1
 * @param {Object}   g3b - parsed GSTR-3B
 * @param {string[]} months
 */
function buildSalesReconTable(tableId, g1, g3b, months) {
  const tbl = document.getElementById(tableId);
  tbl.innerHTML = '';
  buildThead(tbl, ['Month', 'GSTR-1 Tax', '3B Tax', 'Difference', 'Status']);

  const tbody = tbl.createTBody();

  months.forEach(m => {
    const d1 = g1[m]  || { cgst: 0, sgst: 0, igst: 0 };
    const d3 = g3b[m] || { cgst: 0, sgst: 0, igst: 0 };
    const t1   = d1.cgst + d1.sgst + d1.igst;
    const t3   = d3.cgst + d3.sgst + d3.igst;
    const diff = t1 - t3;
    const match = Math.abs(diff) < 1;

    const tr = tbody.insertRow();
    const vals = [m, fmt(t1), fmt(t3), fmtDiff(diff), match ? '✓ Match' : '⚠ Mismatch'];
    vals.forEach((v, i) => {
      const td = tr.insertCell();
      td.textContent = v;
      if (i === 3) td.className = match ? 'diff-zero' : (diff > 0 ? 'diff-pos' : 'diff-neg');
      if (i === 4) td.className = match ? 'status-match' : 'status-mismatch';
    });
  });
}

/**
 * Render ITC reconciliation table: GSTR-2B ITC vs GSTR-3B ITC claimed.
 *
 * @param {string}   tableId
 * @param {Object}   g2b - parsed GSTR-2B
 * @param {Object}   g3b - parsed GSTR-3B
 * @param {string[]} months
 */
function buildITCReconTable(tableId, g2b, g3b, months) {
  const tbl = document.getElementById(tableId);
  tbl.innerHTML = '';
  buildThead(tbl, ['Month', '2B ITC', '3B ITC', 'Difference', 'Status']);

  const tbody = tbl.createTBody();

  months.forEach(m => {
    const d2  = g2b[m] || { cgst: 0, sgst: 0, igst: 0 };
    const d3  = g3b[m] || { itc_cgst: 0, itc_sgst: 0, itc_igst: 0 };
    const t2  = d2.cgst + d2.sgst + d2.igst;
    const t3  = d3.itc_cgst + d3.itc_sgst + d3.itc_igst;
    const diff  = t2 - t3;
    const match = Math.abs(diff) < 1;

    const tr = tbody.insertRow();
    const vals = [m, fmt(t2), fmt(t3), fmtDiff(diff), match ? '✓ Match' : '⚠ Mismatch'];
    vals.forEach((v, i) => {
      const td = tr.insertCell();
      td.textContent = v;
      if (i === 3) td.className = match ? 'diff-zero' : (diff > 0 ? 'diff-pos' : 'diff-neg');
      if (i === 4) td.className = match ? 'status-match' : 'status-mismatch';
    });
  });
}

/**
 * Build and inject summary cards above the tables.
 * @param {string}   containerId
 * @param {Object}   g1
 * @param {Object}   g2b
 * @param {Object}   g3b
 * @param {string[]} months
 */
function buildSummaryCards(containerId, g1, g2b, g3b, months) {
  let totalSales1 = 0, totalSales3b = 0, total2b = 0, total3bItc = 0, mismatches = 0;

  months.forEach(m => {
    const d1  = g1[m]  || {};
    const d3  = g3b[m] || {};
    const d2b = g2b[m] || {};

    totalSales1  += (d1.taxable || 0) + (d1.cgst || 0) + (d1.sgst || 0) + (d1.igst || 0);
    totalSales3b += (d3.taxable || 0) + (d3.cgst || 0) + (d3.sgst || 0) + (d3.igst || 0);
    total2b      += (d2b.cgst   || 0) + (d2b.sgst || 0) + (d2b.igst || 0);
    total3bItc   += (d3.itc_cgst || 0) + (d3.itc_sgst || 0) + (d3.itc_igst || 0);

    const salesDiff = ((d1.cgst || 0) + (d1.sgst || 0) + (d1.igst || 0))
                    - ((d3.cgst || 0) + (d3.sgst || 0) + (d3.igst || 0));
    const itcDiff   = ((d2b.cgst || 0) + (d2b.sgst || 0) + (d2b.igst || 0))
                    - ((d3.itc_cgst || 0) + (d3.itc_sgst || 0) + (d3.itc_igst || 0));

    if (Math.abs(salesDiff) >= 1 || Math.abs(itcDiff) >= 1) mismatches++;
  });

  const salesGap = totalSales1 - totalSales3b;

  const cards = [
    {
      label: 'GSTR-1 Total Sales',
      value: '₹ ' + fmt(totalSales1),
      sub:   'Incl. tax',
      cls:   '',
    },
    {
      label: 'GSTR-3B Total Sales',
      value: '₹ ' + fmt(totalSales3b),
      sub:   'Incl. tax',
      cls:   '',
    },
    {
      label: 'Sales Difference',
      value: '₹ ' + fmt(Math.abs(salesGap)),
      sub:   Math.abs(salesGap) < 1 ? 'No gap' : (salesGap > 0 ? '1 ahead of 3B' : '3B ahead of 1'),
      cls:   Math.abs(salesGap) < 1 ? 'match' : 'mismatch',
    },
    {
      label: 'Months with Mismatch',
      value: String(mismatches),
      sub:   `Of ${months.length} month${months.length !== 1 ? 's' : ''}`,
      cls:   mismatches === 0 ? 'match' : 'mismatch',
    },
  ];

  document.getElementById(containerId).innerHTML = cards.map(c => `
    <div class="summary-card">
      <div class="sc-label">${c.label}</div>
      <div class="sc-value ${c.cls}">${c.value}</div>
      <div class="sc-sub">${c.sub}</div>
    </div>
  `).join('');
}
