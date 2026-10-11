/**
 * booksrecon.js
 * Invoice-by-invoice reconciliation of GSTR-2B against the purchase books
 * (e.g. exported from Tally). Pure functions, no DOM — also loadable in Node
 * for testing.
 *
 * Books rows (the shape any source — Tally, CSV — is normalised into):
 *   { voucherNo, invoiceNo, date, party, gstin, taxable, igst, cgst, sgst,
 *     cess, total, kind }            kind: 'INV' (purchase) | 'CN' (purchase
 *                                          return / debit note issued by us)
 *
 * Matching runs in tiers, most trustworthy first. A book entry is only ever
 * paired with one 2B entry and vice-versa:
 *
 *   1. GSTIN + invoice number          -> "matched" (or "amount differs")
 *   2. no usable GSTIN in books:
 *        invoice number + amount       -> "probable" (a person should confirm)
 *   3. same GSTIN, invoice number differs (typo, prefix, etc.):
 *        amount + date nearby          -> "possible"
 *   everything left                    -> "2B only" / "books only"
 *
 * Tolerances are deliberately explicit constants: reconciliations that
 * silently round things away are how real differences get hidden.
 */
(function (root) {
  'use strict';

  const AMOUNT_TOLERANCE   = 1.0;   // rupees; the portal rounds to whole rupees
  const POSSIBLE_DAY_WINDOW = 10;   // days either side, for tier-3 matches
  const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

  const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
  const round2 = n => Math.round(n * 100) / 100;

  function cleanGstin(v) {
    const g = String(v || '').trim().toUpperCase().replace(/\s+/g, '');
    return GSTIN_RE.test(g) ? g : '';          // anything not a real GSTIN counts as "no GSTIN"
  }

  /**
   * Invoice numbers get typed differently in books than on the supplier's
   * invoice: "INV/0012", "inv-12", "INV 12" are the same document. Compare on
   * letters+digits only, with leading zeros dropped inside each digit run.
   */
  function normInvoiceNo(v) {
    const alnum = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return alnum.replace(/\d+/g, d => d.replace(/^0+(?=\d)/, ''));
  }

  /** Accepts dd-mm-yyyy, dd/mm/yyyy, yyyy-mm-dd and Tally's yyyymmdd. Returns a Date (UTC) or null. */
  function parseDate(v) {
    const s = String(v || '').trim();
    let m;
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)))                 return mk(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s)))      return mk(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s)))  return mk(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
    return null;
    function mk(y, mo, d) { const dt = new Date(Date.UTC(y, mo - 1, d)); return isNaN(dt) ? null : dt; }
  }
  const daysBetween = (a, b) => (a && b) ? Math.abs(a - b) / 86400000 : Infinity;
  const isoDate = d => d ? d.toISOString().slice(0, 10) : '';

  // ── 2B → normalised records ───────────────────────────────────────────────

  /** Sum an invoice/note's amounts, falling back to its line items. */
  function amt(rec, key) {
    if (rec[key] !== undefined && rec[key] !== null && rec[key] !== '') return num(rec[key]);
    return Array.isArray(rec.items) ? rec.items.reduce((s, it) => s + num(it[key]), 0) : 0;
  }

  /**
   * Flatten a raw GSTR-2B JSON (portal getjson) into invoice-level records.
   * Covers B2B invoices (+ amendments), e-commerce documents, and credit/debit
   * notes. Imports and ISD have no supplier invoice number to match on, so
   * they're left out of invoice matching on purpose.
   */
  function flatten2B(raw) {
    const inner = (raw && raw.data) || raw || {};
    const doc = inner.docdata || {};
    const out = [];

    const pushInv = (sup, r, kind) => {
      const taxable = amt(r, 'txval'), igst = amt(r, 'igst'), cgst = amt(r, 'cgst'), sgst = amt(r, 'sgst'), cess = amt(r, 'cess');
      out.push({
        src: '2b', kind,
        ctin: cleanGstin(sup.ctin), party: sup.trdnm || '',
        no: kind === 'INV' ? (r.inum || r.docnum || '') : (r.ntnum || ''),
        date: parseDate(r.dt || r.docdt),
        taxable, igst, cgst, sgst, cess,
        total: r.val !== undefined ? num(r.val) : round2(taxable + igst + cgst + sgst + cess),
        itcAvailable: r.itcavl === 'Y' || r.itcavl === 'Yes',
        reverseCharge: r.rev === 'Y',        // tax is paid by the recipient — not a normal input-tax purchase
        pos: String(r.pos || ''),
        section: kind === 'INV' ? 'B2B' : 'CDN',
      });
    };

    ['b2b', 'b2ba', 'ecom'].forEach(k => (doc[k] || []).forEach(sup => (sup.inv || []).forEach(r => pushInv(sup, r, 'INV'))));
    ['cdnr', 'cdnra'].forEach(k => (doc[k] || []).forEach(sup => (sup.nt || []).forEach(r => {
      // A debit note raised by the supplier increases what we owe → behaves like a purchase invoice.
      pushInv(sup, r, r.typ === 'D' ? 'INV' : 'CN');
    })));
    return out;
  }

  function normaliseBooks(rows) {
    return (rows || []).map((r, i) => {
      const taxable = num(r.taxable), igst = num(r.igst), cgst = num(r.cgst), sgst = num(r.sgst), cess = num(r.cess);
      return {
        src: 'books', idx: i,
        kind: String(r.kind || 'INV').toUpperCase() === 'CN' ? 'CN' : 'INV',
        ctin: cleanGstin(r.gstin), party: r.party || '',
        no: r.invoiceNo || r.voucherNo || '', voucherNo: r.voucherNo || '',
        date: parseDate(r.date),
        taxable, igst, cgst, sgst, cess,
        total: r.total !== undefined && r.total !== '' ? num(r.total) : round2(taxable + igst + cgst + sgst + cess),
        gstinRaw: r.gstin || '',
      };
    });
  }

  const taxOf = r => round2(r.igst + r.cgst + r.sgst + r.cess);
  const close = (a, b) => Math.abs(a - b) <= AMOUNT_TOLERANCE;

  /** Do the money figures agree? Returns the per-field differences either way. */
  function compareAmounts(b, k) {
    const diff = {
      taxable: round2(b.taxable - k.taxable),
      igst: round2(b.igst - k.igst), cgst: round2(b.cgst - k.cgst),
      sgst: round2(b.sgst - k.sgst), cess: round2(b.cess - k.cess),
      tax: round2(taxOf(b) - taxOf(k)),
      total: round2(b.total - k.total),
    };
    const agree = close(b.taxable, k.taxable) && close(taxOf(b), taxOf(k));
    return { agree, diff };
  }

  // ── The matcher ───────────────────────────────────────────────────────────

  function reconcile(raw2b, booksRows) {
    const recs = (Array.isArray(raw2b) ? raw2b : [raw2b]).flatMap(flatten2B);
    const books = normaliseBooks(booksRows);

    const used2b = new Set(), usedBooks = new Set();
    const result = { matched: [], differs: [], probable: [], possible: [], only2b: [], onlyBooks: [], noGstin: [], duplicatesInBooks: [] };

    const pair = (bucket, b, k, note) => {
      used2b.add(k); usedBooks.add(b);
      const { agree, diff } = compareAmounts(b, k);
      const entry = { books: b, twoB: k, diff, note: note || '' };
      if (bucket === 'tier1') (agree ? result.matched : result.differs).push(entry);
      else if (bucket === 'tier2') result.probable.push({ ...entry, amountsAgree: agree });
      else result.possible.push({ ...entry, amountsAgree: agree });
    };

    // Index 2B by (kind|gstin|normalised no) for tier 1.
    const idx2b = new Map();
    recs.forEach(k => {
      const key = `${k.kind}|${k.ctin}|${normInvoiceNo(k.no)}`;
      (idx2b.get(key) || idx2b.set(key, []).get(key)).push(k);
    });

    // Tier 1 — GSTIN + invoice number. Where several candidates share the key
    // (a re-issued/duplicate document), take the one whose amount fits best.
    books.forEach(b => {
      if (!b.ctin) return;
      const cands = (idx2b.get(`${b.kind}|${b.ctin}|${normInvoiceNo(b.no)}`) || []).filter(k => !used2b.has(k));
      if (!cands.length) return;
      cands.sort((x, y) => Math.abs(x.total - b.total) - Math.abs(y.total - b.total));
      pair('tier1', b, cands[0]);
    });

    // Tier 2 — books entries with no usable GSTIN: invoice number + amount.
    // Without a GSTIN a bare invoice number is far too weak to trust ("1",
    // "2" … collide across suppliers), so amount must agree too, and the
    // result is always flagged for a person to confirm.
    books.filter(b => !usedBooks.has(b) && !b.ctin).forEach(b => {
      const no = normInvoiceNo(b.no);
      if (!no) return;
      const cands = recs.filter(k => !used2b.has(k) && k.kind === b.kind && normInvoiceNo(k.no) === no && close(k.total, b.total));
      if (!cands.length) return;
      cands.sort((x, y) => daysBetween(x.date, b.date) - daysBetween(y.date, b.date));
      pair('tier2', b, cands[0], cands.length > 1 ? `${cands.length} 2B entries fit — nearest date chosen` : '');
    });

    // Tier 3 — same GSTIN but the invoice number differs: amount + nearby date,
    // and only when exactly one candidate fits so we never guess between two.
    books.filter(b => !usedBooks.has(b) && b.ctin).forEach(b => {
      const cands = recs.filter(k => !used2b.has(k) && k.kind === b.kind && k.ctin === b.ctin
        && close(k.total, b.total) && daysBetween(k.date, b.date) <= POSSIBLE_DAY_WINDOW);
      if (cands.length === 1) pair('tier3', b, cands[0], 'Invoice number differs');
    });

    // Leftovers.
    recs.filter(k => !used2b.has(k)).forEach(k => result.only2b.push(k));
    books.filter(b => !usedBooks.has(b)).forEach(b => {
      (b.ctin ? result.onlyBooks : result.noGstin).push(b);
    });

    // Same supplier invoice entered twice in books is worth calling out.
    const seen = new Map();
    books.forEach(b => {
      if (!b.ctin || !b.no) return;
      const key = `${b.kind}|${b.ctin}|${normInvoiceNo(b.no)}`;
      (seen.get(key) || seen.set(key, []).get(key)).push(b);
    });
    seen.forEach(list => { if (list.length > 1) result.duplicatesInBooks.push(list); });

    result.summary = summarise(result, recs, books);
    return result;
  }

  function summarise(r, recs, books) {
    const itc = x => taxOf(x) * (x.kind === 'CN' ? -1 : 1);
    const sum = list => round2(list.reduce((s, x) => s + itc(x), 0));
    return {
      counts: {
        twoB: recs.length, books: books.length,
        matched: r.matched.length, differs: r.differs.length, probable: r.probable.length,
        possible: r.possible.length, only2b: r.only2b.length, onlyBooks: r.onlyBooks.length,
        noGstin: r.noGstin.length, duplicatesInBooks: r.duplicatesInBooks.length,
      },
      itc: {
        in2b: sum(recs.filter(k => k.itcAvailable !== false)),
        inBooks: sum(books),
        // ITC the supplier reported that isn't in our books → can claim only after booking it
        only2b: sum(r.only2b),
        // ITC in our books the supplier hasn't reported → at risk, can't be claimed from 2B
        onlyBooks: sum(r.onlyBooks.concat(r.noGstin)),
      },
    };
  }

  const api = { reconcile, flatten2B, normaliseBooks, normInvoiceNo, parseDate, cleanGstin, isoDate, AMOUNT_TOLERANCE, POSSIBLE_DAY_WINDOW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BooksRecon = api;
})(typeof self !== 'undefined' ? self : this);
