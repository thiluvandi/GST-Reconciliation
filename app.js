/**
 * app.js
 * Main application logic: file handling, reconciliation trigger, CSV export.
 */

const files = { r1: null, '2b': null, '3b': null };
let reconData = null;

// ── File upload handling ───────────────────────────────────────────────────

function handleFile(key, input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      files[key] = JSON.parse(e.target.result);
      document.getElementById('card-' + key).classList.add('loaded');
      document.getElementById('fn-' + key).textContent = file.name;
      checkReady();
    } catch (err) {
      showError(`Could not parse ${file.name}: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function checkReady() {
  const ready = files.r1 && files['2b'] && files['3b'];
  document.getElementById('btn-run').disabled = !ready;
  document.getElementById('run-hint').textContent = ready
    ? 'All files loaded — ready to reconcile.'
    : 'Upload all three files to proceed';
}

// ── Reconciliation ─────────────────────────────────────────────────────────

function runRecon() {
  hideError();

  try {
    const g1  = parseGSTR1(files.r1);
    const g2b = parseGSTR2B(files['2b']);
    const g3b = parseGSTR3B(files['3b']);

    const months = allMonthsSorted(g1, g2b, g3b);

    if (months.length === 0 || months[0] === 'Unknown') {
      showError(
        'Could not detect filing period from the JSON files. ' +
        'Make sure you are using portal-downloaded GSTR JSON files.'
      );
      return;
    }

    reconData = { g1, g2b, g3b, months };

    buildSummaryCards('summary-cards', g1, g2b, g3b, months);
    buildSalesTable('tbl-3b-sales', g3b, months);
    buildSalesTable('tbl-1-sales',  g1,  months);
    build2BTable('tbl-2b-itc',     g2b, months);
    buildSalesReconTable('tbl-recon-sales', g1, g3b, months);
    buildITCReconTable('tbl-recon-itc',    g2b, g3b, months);

    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('results').style.display     = 'block';
    document.getElementById('btn-download').style.display = 'inline-block';

  } catch (err) {
    showError('Reconciliation failed: ' + err.message);
    console.error(err);
  }
}

// ── CSV export ─────────────────────────────────────────────────────────────

function downloadCSV() {
  if (!reconData) return;
  const { g1, g2b, g3b, months } = reconData;

  const headers = [
    'Month',
    'GSTR1 Taxable', 'GSTR1 CGST', 'GSTR1 SGST', 'GSTR1 IGST',
    '3B Taxable',    '3B CGST',    '3B SGST',     '3B IGST',
    '2B CGST',       '2B SGST',    '2B IGST',
    '3B ITC CGST',   '3B ITC SGST','3B ITC IGST',
  ];

  const rows = [headers];
  months.forEach(m => {
    const d1  = g1[m]  || {};
    const d2  = g2b[m] || {};
    const d3  = g3b[m] || {};
    rows.push([
      m,
      d1.taxable || 0, d1.cgst || 0, d1.sgst || 0, d1.igst || 0,
      d3.taxable || 0, d3.cgst || 0, d3.sgst || 0, d3.igst || 0,
      d2.cgst || 0,    d2.sgst || 0, d2.igst || 0,
      d3.itc_cgst || 0, d3.itc_sgst || 0, d3.itc_igst || 0,
    ]);
  });

  const csv  = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'GST_Reconciliation.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Reset ──────────────────────────────────────────────────────────────────

function resetAll() {
  ['r1', '2b', '3b'].forEach(k => {
    files[k] = null;
    document.getElementById('card-' + k).classList.remove('loaded');
    document.getElementById('fn-' + k).textContent = '';
    document.getElementById('file-' + k).value     = '';
  });
  document.getElementById('btn-run').disabled               = true;
  document.getElementById('run-hint').textContent           = 'Upload all three files to proceed';
  document.getElementById('placeholder').style.display      = 'block';
  document.getElementById('results').style.display          = 'none';
  document.getElementById('btn-download').style.display     = 'none';
  document.getElementById('summary-cards').innerHTML        = '';
  hideError();
  reconData = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function showError(msg) {
  const b = document.getElementById('error-banner');
  b.textContent  = msg;
  b.style.display = 'block';
}

function hideError() {
  document.getElementById('error-banner').style.display = 'none';
}

// ── Event listeners ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('file-r1').addEventListener('change', e => handleFile('r1', e.target));
  document.getElementById('file-2b').addEventListener('change', e => handleFile('2b', e.target));
  document.getElementById('file-3b').addEventListener('change', e => handleFile('3b', e.target));
  document.getElementById('btn-run').addEventListener('click', runRecon);
  document.getElementById('btn-reset').addEventListener('click', resetAll);
  document.getElementById('btn-download').addEventListener('click', downloadCSV);
});
