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

  /**
   * Are two invoice numbers the same document written with extra bits?
   * Suppliers and accountants add prefixes and suffixes ("INV/24-25/0123"
   * in 2B, "001" in books; "0123/24-25" vs "INV-123/24-25"). Both are split
   * into words — at separators and where letters meet digits, leading zeros
   * dropped — and the shorter must be the whole start or the whole end of the
   * longer and contain a number. So "12" never matches "112", and
   * "CSG/26-27/001" matches "1" or "001". Used only together with matching
   * GSTIN, amounts and dates.
   */
  function invoiceWords(v) {
    return (String(v || '').toUpperCase().match(/[A-Z]+|\d+/g) || []).map(w => (/^\d/.test(w) ? w.replace(/^0+(?=\d)/, '') : w));
  }
  function sameInvoiceLoosely(a, b) {
    const x = invoiceWords(a), y = invoiceWords(b);
    if (!x.length || !y.length) return false;
    const [s, l] = x.length <= y.length ? [x, y] : [y, x];
    if (!s.some(w => /^\d/.test(w))) return false;
    const at = off => s.every((w, i) => w === l[off + i]);
    return at(0) || at(l.length - s.length);
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
    return matchRecords(recs, normaliseBooks(booksRows));
  }

  /**
   * The matcher itself, on any return's invoice records (2B for purchases,
   * GSTR-1 for sales) against normalised book entries. Result buckets keep
   * their purchase names (only2b = "in the return, not in books").
   */
  function matchRecords(recs, books) {
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

    // Tier 1b — "smart" match: same GSTIN, the amounts agree, dates close, and
    // the invoice numbers are the same apart from an added prefix/suffix
    // (sameInvoiceLoosely). Counted as matched, but marked so it can be seen.
    // Only when exactly one 2B entry fits this book entry and that 2B entry
    // fits no other book entry — never a guess between two.
    const smartFits = (b, k) => !used2b.has(k) && k.kind === b.kind && k.ctin === b.ctin
      && close(k.taxable, b.taxable) && close(taxOf(k), taxOf(b))
      && daysBetween(k.date, b.date) <= POSSIBLE_DAY_WINDOW && sameInvoiceLoosely(k.no, b.no);
    const openBooks = books.filter(b => !usedBooks.has(b) && b.ctin);
    openBooks.forEach(b => {
      const cands = recs.filter(k => smartFits(b, k));
      if (cands.length !== 1) return;
      if (openBooks.filter(o => !usedBooks.has(o) && smartFits(o, cands[0])).length !== 1) return;
      used2b.add(cands[0]); usedBooks.add(b);
      result.matched.push({ books: b, twoB: cands[0], diff: compareAmounts(b, cands[0]).diff, smart: true,
        note: `Smart match: invoice no. written as "${b.no}" in books, "${cands[0].no}" in 2B` });
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

    // Leftovers. A leftover book entry with the same invoice number and amount
    // as one that already matched (same GSTIN, or no GSTIN at all) is the
    // same invoice booked a second time — our duplicate, not a supplier that
    // hasn't filed — so it gets its own list and stays out of "ITC at risk".
    const settled = result.matched.concat(result.differs).map(e => e.books);
    result.bookedTwice = [];
    recs.filter(k => !used2b.has(k)).forEach(k => result.only2b.push(k));
    books.filter(b => !usedBooks.has(b)).forEach(b => {
      const first = settled.find(m => m.kind === b.kind && normInvoiceNo(m.no) === normInvoiceNo(b.no) && normInvoiceNo(b.no)
        && close(m.total, b.total) && (!b.ctin || b.ctin === m.ctin));
      if (first) result.bookedTwice.push({ books: b, first });
      else (b.ctin ? result.onlyBooks : result.noGstin).push(b);
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

  // ── Sales: GSTR-1 against the sales books ─────────────────────────────────

  /** Sum an item list's GSTR-1 amounts (txval / iamt / camt / samt / csamt). */
  function r1Amounts(r) {
    const its = Array.isArray(r.itms) ? r.itms.map(i => i.itm_det || i) : [r];
    const s = k => round2(its.reduce((a, i) => a + num(i[k]), 0));
    return { taxable: s('txval'), igst: s('iamt'), cgst: s('camt'), sgst: s('samt'), cess: s('csamt') };
  }

  /**
   * Flatten one GSTR-1 JSON (portal, or the extension's "sections" /
   * "totals" downloads) into invoice records shaped like 2B ones, plus the
   * totals that have no invoices: B2CS (small B2C sales are only ever
   * reported in totals) and, in a totals-only file, the B2B summary.
   * Amended invoices (b2ba) replace the originals they amend.
   */
  function flattenR1(raw) {
    const d = (raw && raw.data) || raw || {};
    const fp = String(d.fp || d.ret_period || '');
    const recs = [];
    const zero = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
    const add = (t, a, sign = 1) => { Object.keys(t).forEach(k => { t[k] = round2(t[k] + sign * a[k]); }); };
    const b2cs = zero(), summaryB2B = zero();
    let summary = false;
    const amended = new Set();
    (d.b2ba || []).forEach(c => (c.inv || []).forEach(r => amended.add(`${cleanGstin(c.ctin)}|${normInvoiceNo(r.oinum)}`)));
    const push = (ctin, r, kind, section, no, dt) => {
      const a = r1Amounts(r);
      recs.push({ src: 'r1', kind, ctin, party: '', no: no || '', date: parseDate(dt), ...a,
        total: r.val !== undefined ? num(r.val) : round2(a.taxable + a.igst + a.cgst + a.sgst + a.cess),
        itcAvailable: true, reverseCharge: r.rchrg === 'Y', pos: String(r.pos || ''), section, fp });
    };
    (d.b2b || []).forEach(c => (c.inv || []).forEach(r => {
      if (String(c.ctin).toUpperCase() === 'SUMMARY') { summary = true; add(summaryB2B, r1Amounts(r)); return; }
      const ctin = cleanGstin(c.ctin);
      if (amended.has(`${ctin}|${normInvoiceNo(r.inum)}`)) return;
      push(ctin, r, 'INV', 'B2B', r.inum, r.idt);
    }));
    (d.b2ba || []).forEach(c => (c.inv || []).forEach(r => push(cleanGstin(c.ctin), r, 'INV', 'B2B', r.inum, r.idt)));
    (d.b2cl || []).forEach(c => (c.inv || []).forEach(r => push('', { ...r, pos: r.pos || c.pos }, 'INV', 'B2CL', r.inum, r.idt)));
    (d.exp || []).forEach(c => (c.inv || []).forEach(r => push('', r, 'INV', 'EXP', r.inum, r.idt)));
    (d.cdnr || []).forEach(c => (c.nt || []).forEach(r => push(cleanGstin(c.ctin), r, r.ntty === 'D' ? 'INV' : 'CN', 'CDNR', r.nt_num, r.nt_dt)));
    (d.cdnur || []).forEach(r => push('', r, r.ntty === 'D' ? 'INV' : 'CN', 'CDNUR', r.nt_num, r.nt_dt));
    (d.b2cs || []).forEach(r => add(b2cs, r1Amounts(r)));
    return { fp, recs, b2cs, summaryB2B, totalsOnly: !!d.totals_only || summary };
  }

  const fpOfDate = d => (d ? String(d.getUTCMonth() + 1).padStart(2, '0') + d.getUTCFullYear() : '');
  const fpLabel = fp => { const m = +fp.slice(0, 2), y = fp.slice(2); return m >= 1 && m <= 12 ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}-${y.slice(2)}` : fp; };

  /**
   * GSTR-1 files vs sales book rows.
   *   invoices: invoice-by-invoice result (matchRecords) for the months whose
   *             GSTR-1 has invoices — B2B, B2CL, exports, credit/debit notes;
   *   months:   for every month, GSTR-1 vs books totals split into
   *             registered (B2B) and unregistered (B2C) sales — the only
   *             possible check for B2CS and for "totals only" downloads.
   * Book entries outside the GSTR-1 months are ignored.
   */
  function reconcileSales(rawR1, salesRows) {
    const files = (Array.isArray(rawR1) ? rawR1 : [rawR1]).map(flattenR1).filter(f => f.fp);
    const byFp = new Map(files.map(f => [f.fp, f]));
    const books = normaliseBooks(salesRows).filter(b => byFp.has(fpOfDate(b.date)));
    const invoiceMonths = new Set(files.filter(f => !f.totalsOnly).map(f => f.fp));
    const invoices = matchRecords(files.filter(f => !f.totalsOnly).flatMap(f => f.recs),
      books.filter(b => invoiceMonths.has(fpOfDate(b.date)) && b.ctin)
        .concat(books.filter(b => invoiceMonths.has(fpOfDate(b.date)) && !b.ctin)));
    // B2CL, export and unregistered-note invoices have no GSTIN on either side,
    // so invoice number + amount (the "probable" tier) is a proper match here.
    invoices.probable = invoices.probable.filter(e => {
      if (e.twoB.ctin) return true;
      (e.amountsAgree ? invoices.matched : invoices.differs).push(e);
      return false;
    });
    // B2C book entries that matched no B2CL/export invoice are B2CS sales: checked in the month totals, not "missing".
    invoices.b2cBooks = invoices.noGstin; invoices.noGstin = [];
    Object.assign(invoices.summary.counts, { matched: invoices.matched.length, differs: invoices.differs.length, probable: invoices.probable.length });

    const signed = (x, k) => (x.kind === 'CN' ? -1 : 1) * x[k];
    const sumOf = (list, k) => round2(list.reduce((s, x) => s + signed(x, k), 0));
    const pack = list => ({ taxable: sumOf(list, 'taxable'), tax: round2(['igst', 'cgst', 'sgst', 'cess'].reduce((s, k) => s + sumOf(list, k), 0)) });
    const taxT = t => round2(t.igst + t.cgst + t.sgst + t.cess);
    const months = files.sort((a, b) => (a.fp.slice(2) + a.fp.slice(0, 2)).localeCompare(b.fp.slice(2) + b.fp.slice(0, 2))).map(f => {
      const mb = books.filter(b => fpOfDate(b.date) === f.fp);
      const reg = f.recs.filter(k => k.ctin), unreg = f.recs.filter(k => !k.ctin);
      const r1 = {
        b2b: { taxable: round2(sumOf(reg, 'taxable') + f.summaryB2B.taxable), tax: round2(pack(reg).tax + taxT(f.summaryB2B)) },
        b2c: { taxable: round2(sumOf(unreg, 'taxable') + f.b2cs.taxable), tax: round2(pack(unreg).tax + taxT(f.b2cs)) },
      };
      const bk = { b2b: pack(mb.filter(b => b.ctin)), b2c: pack(mb.filter(b => !b.ctin)) };
      const tot = x => ({ taxable: round2(x.b2b.taxable + x.b2c.taxable), tax: round2(x.b2b.tax + x.b2c.tax) });
      r1.total = tot(r1); bk.total = tot(bk);
      const diff = { taxable: round2(bk.total.taxable - r1.total.taxable), tax: round2(bk.total.tax - r1.total.tax) };
      return { fp: f.fp, label: fpLabel(f.fp), totalsOnly: f.totalsOnly, r1, books: bk, diff,
        agrees: close(bk.b2b.taxable, r1.b2b.taxable) && close(bk.b2b.tax, r1.b2b.tax) && close(bk.b2c.taxable, r1.b2c.taxable) && close(bk.b2c.tax, r1.b2c.tax) };
    });
    return { invoices, months, totalsOnlyMonths: months.filter(m => m.totalsOnly).map(m => m.label), bookCount: books.length };
  }

  // ── ITC: GSTR-3B claimed vs GSTR-2B available vs books ────────────────────

  const HEADS = ['igst', 'cgst', 'sgst', 'cess'];
  const zeroHeads = () => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
  const addHeads = (t, r, sign = 1) => { HEADS.forEach(h => { t[h] = round2(t[h] + sign * num(r[h])); }); return t; };
  const portalFp = v => { const s = String(v || '').replace(/[^0-9]/g, ''); return s.length === 6 ? s : ''; };
  const fpSortKey = fp => fp.slice(2) + fp.slice(0, 2);

  /** GSTR-3B table 4 for one month. 3B writes cess as csamt and the heads as iamt/camt/samt. */
  function flatten3BItc(raw) {
    const inner = (raw && raw.data) || raw || {};
    const fp = portalFp(inner.fp || inner.ret_period || (raw && (raw.fp || raw.ret_period)));
    const elg = inner.itc_elg || {};
    const heads = r => ({ igst: num(r.iamt), cgst: num(r.camt), sgst: num(r.samt), cess: num(r.csamt) });
    const byType = {};
    (elg.itc_avl || []).forEach(r => { const ty = String(r.ty || 'OTH').toUpperCase(); byType[ty] = addHeads(byType[ty] || zeroHeads(), heads(r)); });
    const pick = (...tys) => tys.reduce((t, ty) => addHeads(t, byType[ty] || zeroHeads()), zeroHeads());
    const reversed = (elg.itc_rev || []).reduce((t, r) => addHeads(t, heads(r)), zeroHeads());
    return {
      fp,
      // Compared with 2B and the books: everything except tax paid under reverse charge.
      claimed: pick('OTH', 'IMPG', 'ISD'),
      other: pick('OTH'), imports: pick('IMPG'), isd: pick('ISD'),
      // Reverse charge (ISRC) and import of services (IMPS) are paid in cash and never appear in 2B.
      rcm: pick('ISRC', 'IMPS'),
      reversed,
      net: elg.itc_net ? heads(elg.itc_net) : addHeads(addHeads(pick('OTH', 'IMPG', 'ISD', 'ISRC', 'IMPS'), zeroHeads()), reversed, -1),
    };
  }

  /** GSTR-2B ITC for one month, split the way table 4 of 3B is. */
  function flatten2BItc(raw) {
    const inner = (raw && raw.data) || raw || {};
    const fp = portalFp(inner.rtnprd || inner.retPrd || (raw && (raw.rtnprd || raw.retPrd)));
    const doc = inner.docdata || {};
    const out = { fp, other: zeroHeads(), imports: zeroHeads(), isd: zeroHeads(), rcm: zeroHeads(), notAvailable: zeroHeads(), notAvailableCount: 0 };
    flatten2B(raw).forEach(k => {
      const sign = k.kind === 'CN' ? -1 : 1;
      if (k.reverseCharge) addHeads(out.rcm, k, sign);
      else if (!k.itcAvailable) { addHeads(out.notAvailable, k, sign); out.notAvailableCount++; }
      else addHeads(out.other, k, sign);
    });
    ['impg', 'impgsez'].forEach(key => (doc[key] || []).forEach(r => addHeads(out.imports, { igst: r.igst, cess: r.cess })));
    (doc.isd || doc.isda || []).forEach(sup => (sup.doclist || [sup]).forEach(d => {
      if (d.itcelg === 'N') return;
      addHeads(out.isd, d, /CN/i.test(d.doctyp || '') ? -1 : 1);
    }));
    out.available = addHeads(addHeads(addHeads(zeroHeads(), out.other), out.imports), out.isd);
    return out;
  }

  /**
   * Month by month: ITC claimed in GSTR-3B (table 4A, reverse charge left
   * out) against ITC available in GSTR-2B and input tax booked in the
   * purchase books (Tally leaves reverse charge out too). Any of the three
   * may be missing for a month; it then shows as null.
   *   diff2b    = 3B − 2B    (> 0: claimed more than 2B shows)
   *   diffBooks = 3B − books (> 0: claimed more than booked)
   */
  function reconcileITC(raw3b, raw2b, booksRows) {
    const list = v => (Array.isArray(v) ? v : v ? [v] : []);
    const g3 = new Map(list(raw3b).map(flatten3BItc).filter(x => x.fp).map(x => [x.fp, x]));
    const g2 = new Map(list(raw2b).map(flatten2BItc).filter(x => x.fp).map(x => [x.fp, x]));
    const haveBooks = Array.isArray(booksRows);
    const fps = [...new Set([...g3.keys(), ...g2.keys()])].sort((a, b) => fpSortKey(a).localeCompare(fpSortKey(b)));
    const want = new Set(fps);
    const booksByFp = new Map();
    if (haveBooks) normaliseBooks(booksRows).forEach(b => {
      const fp = fpOfDate(b.date);
      if (!want.has(fp)) return;
      addHeads(booksByFp.get(fp) || booksByFp.set(fp, zeroHeads()).get(fp), b, b.kind === 'CN' ? -1 : 1);
    });
    const diffOf = (a, b) => (a && b ? addHeads(addHeads(zeroHeads(), a), b, -1) : null);
    const agreeAll = d => !d || HEADS.every(h => Math.abs(d[h]) <= AMOUNT_TOLERANCE);

    const months = fps.map(fp => {
      const t3 = g3.get(fp) || null, t2 = g2.get(fp) || null;
      const claimed = t3 ? t3.claimed : null;
      const available = t2 ? t2.available : null;
      const books = haveBooks ? (booksByFp.get(fp) || zeroHeads()) : null;
      const diff2b = diffOf(claimed, available), diffBooks = diffOf(claimed, books);
      return {
        fp, label: fpLabel(fp), claimed, available, books, diff2b, diffBooks,
        rcm3b: t3 ? t3.rcm : null, reversed: t3 ? t3.reversed : null, net3b: t3 ? t3.net : null,
        rcm2b: t2 ? t2.rcm : null, notAvailable2b: t2 ? t2.notAvailable : null, notAvailableCount: t2 ? t2.notAvailableCount : 0,
        parts: { claimed: t3 && { other: t3.other, imports: t3.imports, isd: t3.isd }, available: t2 && { other: t2.other, imports: t2.imports, isd: t2.isd } },
        agrees2b: agreeAll(diff2b), agreesBooks: agreeAll(diffBooks),
      };
    });

    // The period total covers the months that have a 3B (the claims being checked);
    // a column is left blank if any of those months lacks it.
    const filed = months.filter(m => m.claimed);
    const sumField = k => filed.reduce((t, m) => (m[k] ? addHeads(t, m[k]) : t), zeroHeads());
    const all = k => filed.length > 0 && filed.every(m => m[k]);
    const year = {
      months: filed.map(m => m.label),
      claimed: all('claimed') ? sumField('claimed') : null,
      available: all('available') ? sumField('available') : null,
      books: all('books') ? sumField('books') : null,
      rcm3b: sumField('rcm3b'), reversed: sumField('reversed'), net3b: sumField('net3b'),
    };
    year.diff2b = diffOf(year.claimed, year.available);
    year.diffBooks = diffOf(year.claimed, year.books);
    year.agrees2b = agreeAll(year.diff2b); year.agreesBooks = agreeAll(year.diffBooks);
    return { months, year, missing3b: fps.filter(fp => !g3.has(fp)).map(fpLabel), missing2b: fps.filter(fp => !g2.has(fp)).map(fpLabel) };
  }

  /**
   * Suppliers whose invoices are in the books but not in 2B (they haven't
   * filed, or filed them wrong), with the ITC at stake — the list to chase.
   * Grouped by GSTIN, or by party name when the books have no GSTIN.
   * Largest ITC first.
   */
  function suppliersToChase(r) {
    const groups = new Map();
    r.onlyBooks.concat(r.noGstin).forEach(b => {
      const key = b.ctin || 'name:' + String(b.party || '').trim().toLowerCase();
      const g = groups.get(key) || groups.set(key, { ctin: b.ctin, party: b.party, count: 0, itc: 0, taxable: 0, lastDate: null, invoices: [] }).get(key);
      const sign = b.kind === 'CN' ? -1 : 1;
      g.count++; g.itc = round2(g.itc + sign * taxOf(b)); g.taxable = round2(g.taxable + sign * b.taxable);
      if (b.date && (!g.lastDate || b.date > g.lastDate)) g.lastDate = b.date;
      g.invoices.push(b.no);
    });
    return [...groups.values()].sort((a, b) => b.itc - a.itc || b.count - a.count);
  }

  function summarise(r, recs, books) {
    const itc = x => taxOf(x) * (x.kind === 'CN' ? -1 : 1);
    const sum = list => round2(list.reduce((s, x) => s + itc(x), 0));
    return {
      counts: {
        twoB: recs.length, books: books.length,
        matched: r.matched.length, smartMatched: r.matched.filter(e => e.smart).length, differs: r.differs.length, probable: r.probable.length,
        possible: r.possible.length, only2b: r.only2b.length, onlyBooks: r.onlyBooks.length,
        noGstin: r.noGstin.length, duplicatesInBooks: r.duplicatesInBooks.length, bookedTwice: r.bookedTwice.length,
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


  // ── GST rate helpers (used when booking invoices into Tally) ────────────────
  // GSTR-2B gives each invoice's taxable value and tax only — no rate — so the
  // rate is worked out as tax ÷ taxable and matched to a standard rate.

  const RATE_SLABS = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
  const SPLIT_RATES = [0, 5, 12, 18, 28, 40];     // rates offered when suggesting how a mixed invoice splits
  const rateTolerance = taxable => Math.max(0.05, taxable * 0.0015);   // paise floor, else 0.15 percentage points

  /** The standard rate an invoice's tax implies, or null when it fits none (mixed rates). */
  function impliedRate(taxable, tax) {
    taxable = Number(taxable) || 0; tax = Number(tax) || 0;
    if (!(taxable > 0)) return null;
    if (!(tax > 0.005)) return 0;
    let best = null;
    RATE_SLABS.forEach(s => {
      const d = Math.abs(tax - taxable * s / 100);
      if (d <= rateTolerance(taxable) && (best === null || d < best.d)) best = { s, d };
    });
    return best ? best.s : null;
  }

  /**
   * Two-rate splits that reproduce an invoice's taxable value and tax exactly,
   * most plausible first. Several can fit mathematically, so they are ranked
   * by how "round" the amounts are (invoices are usually written in whole
   * rupees or tens), and a nil rate is never suggested.
   */
  function suggestSplits(taxable, tax) {
    taxable = Number(taxable) || 0; tax = Number(tax) || 0;
    const rates = SPLIT_RATES.filter(r => r > 0);
    const out = [];
    for (let i = 0; i < rates.length; i++) {
      for (let j = i + 1; j < rates.length; j++) {
        const r1 = rates[i], r2 = rates[j];
        const t2 = (tax - taxable * r1 / 100) / ((r2 - r1) / 100);
        const t1 = taxable - t2;
        if (t1 < 0.5 || t2 < 0.5) continue;
        const a = round2(t1), b = round2(taxable - a);
        if (Math.abs((a * r1 + b * r2) / 100 - tax) > rateTolerance(taxable) + 0.01) continue;
        out.push({ parts: [{ rate: r1, taxable: a }, { rate: r2, taxable: b }] });
      }
    }
    // roundness: whole rupees beat paise; trailing zeros beat none
    const roundness = n => (Math.abs(n - Math.round(n)) > 0.004 ? 100 : 0) + (Math.round(n) % 10 === 0 ? 0 : 1) + (Math.round(n) % 100 === 0 ? 0 : 1);
    out.forEach(o => { o.score = roundness(o.parts[0].taxable) + roundness(o.parts[1].taxable); o.round = o.score < 100; });
    return out.sort((x, y) => x.score - y.score);
  }

  /**
   * Turn user-entered parts [{ rate, taxable }] into full rate lines whose
   * tax heads add up exactly to the invoice's. { ok, lines } or { ok:false, error }.
   * k: { taxable, igst, cgst, sgst, cess }
   */
  function splitInvoice(k, parts) {
    parts = (parts || []).filter(p => Number(p.taxable) > 0);
    if (parts.length < 1) return { ok: false, error: 'Add at least one line with a taxable value.' };
    const T = round2(parts.reduce((s, p) => s + Number(p.taxable), 0));
    if (Math.abs(T - k.taxable) > 1.01) return { ok: false, error: `The lines add up to ${T.toFixed(2)} taxable, but the invoice has ${Number(k.taxable).toFixed(2)}.` };
    const heads = ['igst', 'cgst', 'sgst'];
    const invTax = heads.reduce((s, h) => s + k[h], 0);
    const lineTax = parts.map(p => Number(p.taxable) * Number(p.rate) / 100);
    const sumTax = lineTax.reduce((s, x) => s + x, 0);
    if (Math.abs(sumTax - invTax) > Math.max(1, k.taxable * 0.002)) {
      return { ok: false, error: `These rates give ${sumTax.toFixed(2)} tax, but the invoice has ${invTax.toFixed(2)}. Check the rates and amounts.` };
    }
    const lines = parts.map((p, i) => {
      const l = { rate: Number(p.rate), taxable: round2(Number(p.taxable)), igst: 0, cgst: 0, sgst: 0, cess: 0 };
      heads.forEach(h => { l[h] = invTax > 0 ? round2(lineTax[i] * k[h] / invTax) : 0; });
      return l;
    });
    // pin the totals to the invoice: the last line absorbs rounding
    const last = lines[lines.length - 1];
    last.taxable = round2(k.taxable - lines.slice(0, -1).reduce((s, l) => s + l.taxable, 0));
    heads.forEach(h => { last[h] = round2(k[h] - lines.slice(0, -1).reduce((s, l) => s + l[h], 0)); });
    // cess belongs to the highest-rate line
    const top = lines.reduce((a, l) => (l.rate > a.rate ? l : a), lines[0]);
    top.cess = round2(k.cess || 0);
    if (lines.some(l => l.taxable < 0 || heads.some(h => l[h] < 0))) return { ok: false, error: 'The split does not fit the invoice. Check the amounts.' };
    return { ok: true, lines };
  }

  const api = { reconcile, reconcileSales, reconcileITC, flatten3BItc, flatten2BItc, flattenR1, matchRecords, flatten2B, normaliseBooks, normInvoiceNo, invoiceWords, sameInvoiceLoosely, suppliersToChase, parseDate, cleanGstin, isoDate, AMOUNT_TOLERANCE, POSSIBLE_DAY_WINDOW, RATE_SLABS, impliedRate, suggestSplits, splitInvoice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BooksRecon = api;
})(typeof self !== 'undefined' ? self : this);
