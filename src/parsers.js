/**
 * parsers.js
 * Parses portal-downloaded GSTR-1, GSTR-2B, and GSTR-3B JSON files
 * into a normalised month-keyed structure for reconciliation.
 */

const MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];

/**
 * Convert portal filing period string to display label.
 * Handles "042025", "04-2025", "042025" etc.
 * @param {string} rp
 * @returns {string} e.g. "Apr-25"
 */
function retPeriodToLabel(rp) {
  if (!rp) return 'Unknown';
  rp = rp.replace(/-/g, '');
  if (rp.length === 6) {
    const m = parseInt(rp.slice(0, 2), 10);
    const y = rp.slice(4); // last 2 digits of year
    const d = new Date(2000, m - 1, 1);
    return d.toLocaleString('en', { month: 'short' }) + '-' + y;
  }
  return rp;
}

/**
 * Sort key for month labels in financial-year order (Apr first).
 * @param {string} label e.g. "Apr-25"
 * @returns {number}
 */
function monthSortKey(label) {
  const mon = label.slice(0, 3);
  const yr  = parseInt(label.slice(-2), 10);
  const idx = MONTHS.indexOf(mon);
  return yr * 100 + idx;
}

/**
 * Parse GSTR-1 JSON.
 * Aggregates: b2b, b2cs, b2cl, exp (adds); cdnr, cdnur (subtracts).
 * @param {Object} data - Parsed GSTR-1 JSON
 * @returns {Object} { [monthLabel]: { taxable, cgst, sgst, igst } }
 */
function parseGSTR1(data) {
  const month  = retPeriodToLabel(data.fp || '');
  const totals = {};

  function ensure(m) {
    if (!totals[m]) totals[m] = { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
  }
  function add(m, txval = 0, cgst = 0, sgst = 0, igst = 0, sign = 1) {
    ensure(m);
    totals[m].taxable += sign * (txval || 0);
    totals[m].cgst    += sign * (cgst  || 0);
    totals[m].sgst    += sign * (sgst  || 0);
    totals[m].igst    += sign * (igst  || 0);
  }

  // B2B — registered buyers
  (data.b2b || []).forEach(supplier =>
    (supplier.inv || []).forEach(inv =>
      (inv.itms || []).forEach(item => {
        const d = item.itm_det || {};
        add(month, d.txval, d.camt, d.samt, d.iamt);
      })
    )
  );

  // B2CS — unregistered, intra-state (small)
  (data.b2cs || []).forEach(r => add(month, r.txval, r.camt, r.samt, r.iamt));

  // B2CL — unregistered, inter-state (large)
  (data.b2cl || []).forEach(r =>
    (r.inv || []).forEach(inv =>
      (inv.itms || []).forEach(item => {
        const d = item.itm_det || {};
        add(month, d.txval, 0, 0, d.iamt);
      })
    )
  );

  // Exports (zero-rated — tax is usually 0 but include taxable value)
  (data.exp || []).forEach(r =>
    (r.inv || []).forEach(inv =>
      (inv.itms || []).forEach(item => {
        const d = item.itm_det || {};
        add(month, d.txval, 0, 0, d.iamt);
      })
    )
  );

  // CDNR — credit notes to registered buyers (subtract)
  (data.cdnr || []).forEach(supplier =>
    (supplier.nt || []).forEach(note =>
      (note.itms || []).forEach(item => {
        const d = item.itm_det || {};
        add(month, d.txval, d.camt, d.samt, d.iamt, -1);
      })
    )
  );

  // CDNUR — credit notes to unregistered buyers (subtract)
  (data.cdnur || []).forEach(note =>
    (note.itms || []).forEach(item => {
      const d = item.itm_det || {};
      add(month, d.txval, 0, 0, d.iamt, -1);
    })
  );

  return totals;
}

/**
 * Parse GSTR-2B JSON.
 * Aggregates: b2b, b2ba (amended B2B), ecom (adds); cdnr, cdnra (subtracts);
 * impg, impgsez (adds). Unlike GSTR-1/3B, GSTR-2B line items carry their tax
 * amounts directly as cgst/sgst/igst (not camt/samt/iamt), and suppliers list
 * their line items under `inv` (invoices) or `nt` (credit/debit notes), not
 * `docs`.
 * @param {Object} data - Parsed GSTR-2B JSON
 * @returns {Object} { [monthLabel]: { cgst, sgst, igst } }
 */
function parseGSTR2B(data) {
  const inner  = data.data || data;
  const rtnprd = inner.rtnprd || inner.retPrd || data.rtnprd || data.retPrd || '';
  const month  = retPeriodToLabel(rtnprd);
  const totals = {};

  function ensure(m) {
    if (!totals[m]) totals[m] = { cgst: 0, sgst: 0, igst: 0 };
  }
  function add(m, cgst = 0, sgst = 0, igst = 0, sign = 1) {
    ensure(m);
    totals[m].cgst += sign * (cgst || 0);
    totals[m].sgst += sign * (sgst || 0);
    totals[m].igst += sign * (igst || 0);
  }

  const doc = inner.docdata || {};

  // B2B, amended B2B, and e-commerce operator supplies — eligible ITC (adds)
  ['b2b', 'b2ba', 'ecom'].forEach(key =>
    (doc[key] || []).forEach(supplier =>
      (supplier.inv || []).forEach(inv => add(month, inv.cgst, inv.sgst, inv.igst))
    )
  );

  // CDNR and amended CDNR — credit notes (typ 'C') reduce ITC, debit notes
  // (typ 'D') increase it
  ['cdnr', 'cdnra'].forEach(key =>
    (doc[key] || []).forEach(supplier =>
      (supplier.nt || []).forEach(nt => add(month, nt.cgst, nt.sgst, nt.igst, nt.typ === 'D' ? 1 : -1))
    )
  );

  // Import of goods
  (doc.impg    || []).forEach(r => add(month, 0, 0, r.igst));
  (doc.impgsez || []).forEach(r => add(month, 0, 0, r.igst));

  return totals;
}

/**
 * Parse GSTR-3B JSON.
 * Extracts outward liability (sup_details.osup_det) and ITC claimed (itc_elg.itc_avl).
 * @param {Object} data - Parsed GSTR-3B JSON
 * @returns {Object} { [monthLabel]: { taxable, cgst, sgst, igst, itc_cgst, itc_sgst, itc_igst } }
 */
function parseGSTR3B(data) {
  const inner  = data.data || data;
  const fp     = inner.fp || inner.ret_period || data.fp || data.ret_period || '';
  const month  = retPeriodToLabel(fp);

  const sup  = inner.sup_details || {};
  const osup = sup.osup_det      || {};
  const itcAvl = (inner.itc_elg || {}).itc_avl || [];

  let itcCgst = 0, itcSgst = 0, itcIgst = 0;
  itcAvl.forEach(r => {
    itcCgst += +(r.camt || 0);
    itcSgst += +(r.samt || 0);
    itcIgst += +(r.iamt || 0);
  });

  return {
    [month]: {
      taxable:  +(osup.txval || 0),
      cgst:     +(osup.camt  || 0),
      sgst:     +(osup.samt  || 0),
      igst:     +(osup.iamt  || 0),
      itc_cgst: itcCgst,
      itc_sgst: itcSgst,
      itc_igst: itcIgst,
    }
  };
}

/**
 * Merge all month keys from multiple month-data objects, sorted in FY order.
 * @param {...Object} maps
 * @returns {string[]}
 */
function allMonthsSorted(...maps) {
  const keys = new Set();
  maps.forEach(m => Object.keys(m).forEach(k => keys.add(k)));
  return [...keys].sort((a, b) => monthSortKey(a) - monthSortKey(b));
}

/**
 * Detect the filing-period month label for a raw (unparsed) GSTR JSON file,
 * without running the full aggregation. Used at upload time to group files
 * and catch duplicate-month uploads early.
 * @param {'r1'|'2b'|'3b'} type
 * @param {Object} data - raw parsed JSON
 * @returns {string} month label, or 'Unknown'
 */
function detectMonth(type, data) {
  let period = '';
  if (type === 'r1') {
    period = data.fp || '';
  } else if (type === '2b') {
    const inner = data.data || data;
    period = inner.rtnprd || inner.retPrd || data.rtnprd || data.retPrd || '';
  } else if (type === '3b') {
    const inner = data.data || data;
    period = inner.fp || inner.ret_period || data.fp || data.ret_period || '';
  }
  return retPeriodToLabel(period);
}

/**
 * Merge a set of raw files (one per month, keyed by month label) for a single
 * return type into one month-keyed totals map, using the given per-file parser.
 * @param {Object.<string,{name:string,data:Object}>} monthEntries
 * @param {Function} parserFn - parseGSTR1 | parseGSTR2B | parseGSTR3B
 * @returns {Object}
 */
function mergeParsedFiles(monthEntries, parserFn) {
  const agg = {};
  Object.values(monthEntries).forEach(entry => {
    Object.assign(agg, parserFn(entry.data));
  });
  return agg;
}
