/**
 * xlsx-export.js
 * Builds a formatted GST reconciliation workbook (Workings / Reconciliation /
 * Notes sheets) matching the client-provided report template, using ExcelJS.
 */

const XLSX_COLORS = {
  headerFill:  'FF1F4E79',
  headerFont:  'FFFFFFFF',
  titleFont:   'FF1F4E79',
  totalFill:   'FFD6E4F0',
  matchFill:   'FFB3FFB3',
  mismatchFill:'FFFFD966',
};

const THIN_BORDER = {
  top:    { style: 'thin' },
  left:   { style: 'thin' },
  bottom: { style: 'thin' },
  right:  { style: 'thin' },
};

const NUMFMT_ROW   = '#,##0.00;(#,##0.00);\\-';
const NUMFMT_TOTAL = '#,##0.00';

function fyLabel(months) {
  if (!months.length) return '';
  const startYr = parseInt(months[0].slice(-2), 10);
  const endYr   = (startYr + 1) % 100;
  return `FY 20${startYr}-${String(endYr).padStart(2, '0')}`;
}

function styleHeaderCell(cell) {
  cell.font   = { bold: true, color: { argb: XLSX_COLORS.headerFont } };
  cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_COLORS.headerFill } };
  cell.border = THIN_BORDER;
}

function styleDataCell(cell, numFmt) {
  cell.border = THIN_BORDER;
  if (numFmt) cell.numFmt = numFmt;
}

function styleTotalCell(cell, numFmt) {
  cell.font   = { bold: true };
  cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_COLORS.totalFill } };
  cell.border = THIN_BORDER;
  if (numFmt) cell.numFmt = numFmt;
}

function sectionTitle(sheet, coord, text) {
  const cell = sheet.getCell(coord);
  cell.value = text;
  cell.font  = { bold: true, color: { argb: XLSX_COLORS.titleFont } };
}

/**
 * Write a sales-style table (Months, Taxable Value, CGST, SGST, IGST, Total Amount)
 * starting at the given row/col, for the given month-keyed data map.
 * @returns {number} the row after the total row (next free row)
 */
function writeSalesTable(sheet, startRow, startCol, months, monthData) {
  const c = startCol;
  const headers = ['Months', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total Amount'];
  headers.forEach((h, i) => {
    const cell = sheet.getCell(startRow, c + i);
    cell.value = h;
    styleHeaderCell(cell);
  });

  const firstDataRow = startRow + 1;
  months.forEach((m, idx) => {
    const row = firstDataRow + idx;
    const d = monthData[m] || { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    sheet.getCell(row, c).value = m;
    styleDataCell(sheet.getCell(row, c));
    sheet.getCell(row, c + 1).value = d.taxable || 0;
    sheet.getCell(row, c + 2).value = d.cgst || 0;
    sheet.getCell(row, c + 3).value = d.sgst || 0;
    sheet.getCell(row, c + 4).value = d.igst || 0;
    [1, 2, 3, 4].forEach(off => styleDataCell(sheet.getCell(row, c + off), NUMFMT_ROW));
    const totalCell = sheet.getCell(row, c + 5);
    totalCell.value = { formula: `SUM(${sheet.getCell(row, c + 1).address}:${sheet.getCell(row, c + 4).address})` };
    styleDataCell(totalCell, NUMFMT_ROW);
  });

  const totalRow = firstDataRow + months.length;
  sheet.getCell(totalRow, c).value = 'Total';
  styleTotalCell(sheet.getCell(totalRow, c));
  for (let off = 1; off <= 5; off++) {
    const colLetter = sheet.getCell(firstDataRow, c + off).address.replace(/\d+$/, '');
    const cell = sheet.getCell(totalRow, c + off);
    if (months.length > 0) {
      cell.value = { formula: `SUM(${colLetter}${firstDataRow}:${colLetter}${totalRow - 1})` };
    } else {
      cell.value = 0;
    }
    styleTotalCell(cell, NUMFMT_TOTAL);
  }

  return totalRow + 1;
}

/**
 * Write the ITC-style table (Months, CGST, SGST, IGST, Total Amount).
 * @returns {number} the row after the total row
 */
function writeItcTable(sheet, startRow, startCol, months, monthData) {
  const c = startCol;
  const headers = ['Months', 'CGST', 'SGST', 'IGST', 'Total Amount'];
  headers.forEach((h, i) => {
    const cell = sheet.getCell(startRow, c + i);
    cell.value = h;
    styleHeaderCell(cell);
  });

  const firstDataRow = startRow + 1;
  months.forEach((m, idx) => {
    const row = firstDataRow + idx;
    const d = monthData[m] || { cgst: 0, sgst: 0, igst: 0 };
    sheet.getCell(row, c).value = m;
    styleDataCell(sheet.getCell(row, c));
    sheet.getCell(row, c + 1).value = d.cgst || 0;
    sheet.getCell(row, c + 2).value = d.sgst || 0;
    sheet.getCell(row, c + 3).value = d.igst || 0;
    [1, 2, 3].forEach(off => styleDataCell(sheet.getCell(row, c + off), NUMFMT_ROW));
    const totalCell = sheet.getCell(row, c + 4);
    totalCell.value = { formula: `SUM(${sheet.getCell(row, c + 1).address}:${sheet.getCell(row, c + 3).address})` };
    styleDataCell(totalCell, NUMFMT_ROW);
  });

  const totalRow = firstDataRow + months.length;
  sheet.getCell(totalRow, c).value = 'Total';
  styleTotalCell(sheet.getCell(totalRow, c));
  for (let off = 1; off <= 4; off++) {
    const colLetter = sheet.getCell(firstDataRow, c + off).address.replace(/\d+$/, '');
    const cell = sheet.getCell(totalRow, c + off);
    if (months.length > 0) {
      cell.value = { formula: `SUM(${colLetter}${firstDataRow}:${colLetter}${totalRow - 1})` };
    } else {
      cell.value = 0;
    }
    styleTotalCell(cell, NUMFMT_TOTAL);
  }

  return totalRow + 1;
}

/**
 * Precompute the row numbers of the Workings sheet so the Reconciliation
 * sheet can link to the underlying figures instead of hardcoding them.
 * @param {number} n - number of months
 */
function workingsLayout(n) {
  const sales3bDataStart = 5;
  const sales3bTotalRow  = sales3bDataStart + n;          // row 5+n
  const itc2bDataStart   = 5;                             // aligned with sales3b rows
  const g1TitleRow       = sales3bTotalRow + 1 + 2;        // one row after total, +2 blank rows
  const g1DataStart      = g1TitleRow + 2;                 // title row, header row, then data
  const g1TotalRow       = g1DataStart + n;
  const itc3bDataStart   = g1DataStart;                    // aligned with GSTR-1 rows
  return { sales3bDataStart, itc2bDataStart, g1TitleRow, g1DataStart, g1TotalRow, itc3bDataStart };
}

function buildWorkingsSheet(wb, g1, g2b, g3b, months) {
  const sheet = wb.addWorksheet('Workings');
  sheet.columns = [
    { width: 12 }, { width: 16 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 16 },
    { width: 3 },
    { width: 12 }, { width: 16 }, { width: 12 }, { width: 12 }, { width: 16 },
  ];

  const n = months.length;
  const layout = workingsLayout(n);

  sectionTitle(sheet, 'A3', 'Sales As Per GSTR-3B');
  sectionTitle(sheet, 'H3', 'ITC As Per GSTR-2B');
  writeSalesTable(sheet, 4, 1, months, g3b);
  writeItcTable(sheet, 4, 8, months, g2b);

  sectionTitle(sheet, `A${layout.g1TitleRow}`, 'Sales As Per GSTR-1');
  sectionTitle(sheet, `H${layout.g1TitleRow}`, 'ITC Claimed As Per GSTR-3B');
  writeSalesTable(sheet, layout.g1TitleRow + 1, 1, months, g1);

  const g3bItc = {};
  months.forEach(m => {
    const d = g3b[m] || {};
    g3bItc[m] = { cgst: d.itc_cgst || 0, sgst: d.itc_sgst || 0, igst: d.itc_igst || 0 };
  });
  writeItcTable(sheet, layout.g1TitleRow + 1, 8, months, g3bItc);

  return layout;
}

function buildReconciliationSheet(wb, g1, g2b, g3b, months, fy, layout) {
  const sheet = wb.addWorksheet('Reconciliation');
  sheet.columns = Array(10).fill({ width: 15 });
  sheet.getColumn(1).width = 14;

  sheet.mergeCells('A1:J1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = `GST Reconciliation Summary — ${fy}`;
  titleCell.font  = { bold: true, color: { argb: XLSX_COLORS.titleFont }, size: 13 };

  sectionTitle(sheet, 'A3', 'A. Sales Reconciliation: GSTR-1 vs GSTR-3B');
  const salesHeaders = ['Month', 'GSTR-1 Taxable', 'GSTR-1 Tax', 'GSTR-3B Taxable', 'GSTR-3B Tax', 'Diff (Taxable)', 'Diff (Tax)', 'Status'];
  salesHeaders.forEach((h, i) => {
    const cell = sheet.getCell(4, 1 + i);
    cell.value = h;
    styleHeaderCell(cell);
  });

  const salesFirstRow = 5;
  months.forEach((m, idx) => {
    const row   = salesFirstRow + idx;
    const g1Row = layout.g1DataStart + idx;        // Workings!B..E (taxable,cgst,sgst,igst) for GSTR-1
    const b3Row = layout.sales3bDataStart + idx;    // Workings!B..E for GSTR-3B

    const d1 = g1[m]  || { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    const d3 = g3b[m] || { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    const g1Tax = d1.cgst + d1.sgst + d1.igst;
    const g3Tax = d3.cgst + d3.sgst + d3.igst;
    const diffTaxable = d1.taxable - d3.taxable;
    const diffTax = g1Tax - g3Tax;
    const match = Math.abs(diffTaxable) < 1 && Math.abs(diffTax) < 1;

    sheet.getCell(row, 1).value = m;
    styleDataCell(sheet.getCell(row, 1));
    sheet.getCell(row, 2).value = { formula: `Workings!B${g1Row}` };
    sheet.getCell(row, 3).value = { formula: `SUM(Workings!C${g1Row}:E${g1Row})` };
    sheet.getCell(row, 4).value = { formula: `Workings!B${b3Row}` };
    sheet.getCell(row, 5).value = { formula: `SUM(Workings!C${b3Row}:E${b3Row})` };
    [2, 3, 4, 5].forEach(col => styleDataCell(sheet.getCell(row, col), NUMFMT_ROW));

    const diffTaxableCell = sheet.getCell(row, 6);
    diffTaxableCell.value = { formula: `B${row}-D${row}` };
    const diffTaxCell = sheet.getCell(row, 7);
    diffTaxCell.value = { formula: `C${row}-E${row}` };
    [diffTaxableCell, diffTaxCell].forEach(cell => {
      styleDataCell(cell, NUMFMT_ROW);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: match ? XLSX_COLORS.matchFill : XLSX_COLORS.mismatchFill } };
    });

    const statusCell = sheet.getCell(row, 8);
    statusCell.value = match ? '✓ Match' : '⚠ Mismatch';
    styleDataCell(statusCell);
  });

  const itcTitleRow = salesFirstRow + months.length + 1;
  sectionTitle(sheet, `A${itcTitleRow}`, 'B. ITC Reconciliation: GSTR-2B vs GSTR-3B ITC Claimed');
  const itcHeaderRow = itcTitleRow + 1;
  const itcHeaders = ['Month', '2B CGST', '2B SGST', '2B IGST', '2B Total', '3B ITC Total', 'Difference', 'Status'];
  itcHeaders.forEach((h, i) => {
    const cell = sheet.getCell(itcHeaderRow, 1 + i);
    cell.value = h;
    styleHeaderCell(cell);
  });

  const itcFirstRow = itcHeaderRow + 1;
  months.forEach((m, idx) => {
    const row     = itcFirstRow + idx;
    const b2Row   = layout.itc2bDataStart + idx;   // Workings!I..K (cgst,sgst,igst) for 2B
    const b3ItcRow = layout.itc3bDataStart + idx;  // Workings!I..K for 3B ITC claimed

    const d2 = g2b[m] || { cgst: 0, sgst: 0, igst: 0 };
    const d3 = g3b[m] || { itc_cgst: 0, itc_sgst: 0, itc_igst: 0 };
    const t2 = d2.cgst + d2.sgst + d2.igst;
    const t3 = (d3.itc_cgst || 0) + (d3.itc_sgst || 0) + (d3.itc_igst || 0);
    const diff = t2 - t3;
    const match = Math.abs(diff) < 1;

    sheet.getCell(row, 1).value = m;
    styleDataCell(sheet.getCell(row, 1));
    sheet.getCell(row, 2).value = { formula: `Workings!I${b2Row}` };
    sheet.getCell(row, 3).value = { formula: `Workings!J${b2Row}` };
    sheet.getCell(row, 4).value = { formula: `Workings!K${b2Row}` };
    [2, 3, 4].forEach(col => styleDataCell(sheet.getCell(row, col), NUMFMT_ROW));

    const totalCell = sheet.getCell(row, 5);
    totalCell.value = { formula: `SUM(B${row}:D${row})` };
    styleDataCell(totalCell, NUMFMT_ROW);

    const itcTotalCell = sheet.getCell(row, 6);
    itcTotalCell.value = { formula: `SUM(Workings!I${b3ItcRow}:K${b3ItcRow})` };
    styleDataCell(itcTotalCell, NUMFMT_ROW);

    const diffCell = sheet.getCell(row, 7);
    diffCell.value = { formula: `E${row}-F${row}` };
    styleDataCell(diffCell, NUMFMT_ROW);
    diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: match ? XLSX_COLORS.matchFill : XLSX_COLORS.mismatchFill } };

    const statusCell = sheet.getCell(row, 8);
    statusCell.value = match ? '✓ Match' : '⚠ Mismatch';
    styleDataCell(statusCell);
  });
}

function buildNotesSheet(wb) {
  const sheet = wb.addWorksheet('Notes');
  sheet.getColumn(1).width = 80;

  const titleCell = sheet.getCell('A1');
  titleCell.value = 'Reconciliation Notes';
  titleCell.font  = { bold: true, color: { argb: XLSX_COLORS.titleFont } };

  const notes = [
    '• GSTR-1 figures are aggregated from: B2B, B2CS, B2CL, Export invoices (less CDNR/CDNUR credit notes).',
    "• GSTR-3B figures are from the 'osup_det' (taxable outward supplies) section.",
    '• GSTR-2B ITC figures aggregate all eligible ITC from B2B, IMPG, IMPGSEZ (less CDNR credit notes).',
    '• Differences < ₹1 are treated as rounding and marked as Match.',
    '• Amber cells in the Reconciliation sheet indicate values that need investigation.',
    '• Common reasons for Sales mismatch: amendments filed in a later period, timing differences.',
    "• Common reasons for ITC mismatch: ITC not yet availed, reversed, or supplier hasn't filed.",
  ];
  notes.forEach((text, i) => { sheet.getCell(3 + i, 1).value = text; });

  const generatedRow = 3 + notes.length + 1;
  const now = new Date();
  const MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const pad2 = n => String(n).padStart(2, '0');
  const stamp = `${pad2(now.getDate())}-${MON3[now.getMonth()]}-${now.getFullYear()} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  sheet.getCell(generatedRow, 1).value = `Generated on: ${stamp}`;
}

async function downloadExcel() {
  if (!reconData) return;
  const { g1, g2b, g3b, months } = reconData;
  const fy = fyLabel(months);

  const wb = new ExcelJS.Workbook();
  const layout = buildWorkingsSheet(wb, g1, g2b, g3b, months);
  buildReconciliationSheet(wb, g1, g2b, g3b, months, fy, layout);
  buildNotesSheet(wb);

  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement('a');
  a.href       = url;
  a.download   = `GST_Reconciliation_${fy.replace('FY ', '')}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
