/**
 * app.js
 * Main application logic: multi-file handling (up to 12 months per return
 * type), reconciliation trigger, CSV export.
 */

const MAX_FILES = 12;
const TYPE_LABEL = { r1: 'GSTR-1', '2b': 'GSTR-2B', '3b': 'GSTR-3B' };
const PARSER = { r1: parseGSTR1, '2b': parseGSTR2B, '3b': parseGSTR3B };

// files[key] = { [month]: { name, data } }
const files = { r1: {}, '2b': {}, '3b': {} };
let reconData = null;

// ── File upload handling ───────────────────────────────────────────────────

function readFileAsJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => {
      try { resolve(JSON.parse(e.target.result)); }
      catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsText(file);
  });
}

async function handleFiles(key, fileList) {
  const incoming = Array.from(fileList);
  const notices  = [];

  for (const file of incoming) {
    if (Object.keys(files[key]).length >= MAX_FILES) {
      notices.push({ type: 'warn', text: `Skipped "${file.name}" — ${TYPE_LABEL[key]} already has ${MAX_FILES} months loaded.` });
      continue;
    }
    let data;
    try {
      data = await readFileAsJSON(file);
    } catch (err) {
      notices.push({ type: 'error', text: `Could not parse "${file.name}": ${err.message}` });
      continue;
    }
    const month = detectMonth(key, data);
    if (month === 'Unknown') {
      notices.push({ type: 'error', text: `Skipped "${file.name}" — could not detect a filing period.` });
      continue;
    }
    if (files[key][month]) {
      notices.push({ type: 'warn', text: `${TYPE_LABEL[key]} ${month}: replaced "${files[key][month].name}" with "${file.name}".` });
    }
    files[key][month] = { name: file.name, data };
  }

  notices.forEach(n => addNotice(n.type, n.text));
  renderFileChips(key);
  checkReady();
}

function removeFile(key, month) {
  delete files[key][month];
  renderFileChips(key);
  checkReady();
}

function renderFileChips(key) {
  const months = Object.keys(files[key]).sort((a, b) => monthSortKey(a) - monthSortKey(b));
  const wrap   = document.getElementById('chips-' + key);
  const count  = document.getElementById('count-' + key);
  const card   = document.getElementById('card-' + key);

  count.textContent = `${months.length}/${MAX_FILES}`;
  card.classList.toggle('has-files', months.length > 0);
  card.classList.toggle('full', months.length >= MAX_FILES);

  if (months.length === 0) {
    wrap.innerHTML = `<div class="chips-empty">No files added yet</div>`;
    return;
  }

  wrap.innerHTML = months.map(m => `
    <span class="chip" title="${escapeHtml(files[key][m].name)}">
      ${m}
      <button type="button" class="chip-x" data-key="${key}" data-month="${m}" aria-label="Remove ${m}">&times;</button>
    </span>
  `).join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function checkReady() {
  const counts = ['r1', '2b', '3b'].map(k => Object.keys(files[k]).length);
  const ready  = counts.every(c => c > 0);
  document.getElementById('btn-run').disabled = !ready;

  const total = counts.reduce((a, b) => a + b, 0);
  document.getElementById('run-hint').textContent = ready
    ? `${total} month${total !== 1 ? 's' : ''} loaded across all three returns — ready to reconcile.`
    : 'Add at least one file for each of GSTR-1, GSTR-2B, and GSTR-3B to proceed.';
}

// ── Reconciliation ─────────────────────────────────────────────────────────

function runRecon() {
  clearNotices();

  try {
    const g1  = mergeParsedFiles(files.r1,  PARSER.r1);
    const g2b = mergeParsedFiles(files['2b'], PARSER['2b']);
    const g3b = mergeParsedFiles(files['3b'], PARSER['3b']);

    const months = allMonthsSorted(g1, g2b, g3b);

    if (months.length === 0) {
      addNotice('error', 'No valid filing periods found in the uploaded files.');
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
    addNotice('error', 'Reconciliation failed: ' + err.message);
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
    files[k] = {};
    document.getElementById('file-' + k).value = '';
    renderFileChips(k);
  });
  document.getElementById('btn-run').disabled               = true;
  document.getElementById('run-hint').textContent           = 'Add at least one file for each of GSTR-1, GSTR-2B, and GSTR-3B to proceed.';
  document.getElementById('placeholder').style.display      = 'block';
  document.getElementById('results').style.display          = 'none';
  document.getElementById('btn-download').style.display     = 'none';
  document.getElementById('summary-cards').innerHTML        = '';
  clearNotices();
  reconData = null;
}

// ── Notices (errors & warnings) ─────────────────────────────────────────────

function addNotice(type, text) {
  const list = document.getElementById('notice-list');
  const item = document.createElement('div');
  item.className = 'notice notice-' + type;
  item.innerHTML = `<span>${escapeHtml(text)}</span><button type="button" class="notice-x" aria-label="Dismiss">&times;</button>`;
  item.querySelector('.notice-x').addEventListener('click', () => item.remove());
  list.appendChild(item);
}

function clearNotices() {
  document.getElementById('notice-list').innerHTML = '';
}

// ── Event listeners ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  ['r1', '2b', '3b'].forEach(key => {
    document.getElementById('file-' + key).addEventListener('change', e => {
      handleFiles(key, e.target.files);
      e.target.value = '';
    });
    renderFileChips(key);
  });

  document.body.addEventListener('click', e => {
    if (e.target.matches('.chip-x')) {
      removeFile(e.target.dataset.key, e.target.dataset.month);
    }
  });

  document.getElementById('btn-run').addEventListener('click', runRecon);
  document.getElementById('btn-reset').addEventListener('click', resetAll);
  document.getElementById('btn-download').addEventListener('click', downloadCSV);
});
