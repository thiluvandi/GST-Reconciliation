# GST Reconciliation Tool

A client-side web app for reconciling GSTR-1, GSTR-2B, and GSTR-3B returns across a full financial year. No data leaves your browser — everything is processed locally.

## Usage

1. Open `index.html` in a browser (or serve with any static host).
2. For each of GSTR-1, GSTR-2B, and GSTR-3B, add up to 12 portal-downloaded monthly JSON files (multi-select is supported). Each card shows the months loaded as removable chips.
3. Uploading a file for a month that's already loaded replaces the earlier one — a warning banner confirms which file was replaced.
4. Click **Run Reconciliation** once at least one file is loaded for all three return types (a full 12 months isn't required to run).
5. Review the tables and click **Download Excel** for a formatted `.xlsx` report.

## What it reconciles

| Section | Compares |
|---|---|
| Sales as per GSTR-3B | Outward tax liability declared in 3B |
| Sales as per GSTR-1 | Outward supplies declared in GSTR-1 |
| ITC as per GSTR-2B | Eligible ITC from all suppliers |
| Sales Recon | GSTR-1 tax vs GSTR-3B tax (month-wise diff) |
| ITC Recon | GSTR-2B ITC vs ITC claimed in GSTR-3B |

## GSTR-1 aggregation logic

Adds: `b2b`, `b2cs`, `b2cl`, `exp`  
Subtracts: `cdnr`, `cdnur` (credit notes)

## GSTR-2B aggregation logic

Adds: `b2b`, `b2ba` (amended B2B), `ecom` (e-commerce operator supplies), `impg`, `impgsez`  
Subtracts: `cdnr`/`cdnra` notes with `typ: "C"` (credit notes) — adds instead for `typ: "D"` (debit notes)

Unlike GSTR-1/3B, GSTR-2B line items carry tax amounts directly as `cgst`/`sgst`/`igst` (not `camt`/`samt`/`iamt`), under `inv` (invoices) or `nt` (notes) arrays, not `docs`.

## GSTR-3B fields used

- Outward liability: `sup_details.osup_det`
- ITC claimed: `itc_elg.itc_avl`

## GSTR-2B vs Tally books

The **GSTR-2B vs Books** section matches every GSTR-2B invoice against the purchase entries in Tally.

- **Import from Tally** reads the purchase register for a From/To month range straight from TallyPrime running on the same PC (HTTP/XML server, port 9000) and reconciles it with the loaded GSTR-2B files. A CSV/JSON register is still available under "No Tally connection?".
- **Send selected to Tally** books the invoices that are in GSTR-2B but not in your books as Purchase vouchers (credit notes become Debit Notes). You tick the invoices, check a preview (supplier ledgers that will be created, ledger names, totals), then confirm. Reverse-charge and ITC-not-available invoices are not offered. Ledger names are remembered in this browser.

The page can't call Tally directly (Tally sends no CORS headers; this site is https), so both go through the **BoltYards GSTR downloader** browser extension, v1.6.0 or later, which relays page requests to `localhost:9000`. Nothing leaves your computer.

## Excel export

**Download Excel** produces a 3-sheet workbook — **Workings** (per-month source tables with `SUM()` totals for GSTR-1, GSTR-2B, and GSTR-3B ITC), **Reconciliation** (sales and ITC recon, linked to Workings via formulas, with match rows filled green and mismatches filled amber), and **Notes**. Every derived figure is a live formula, not a hardcoded value.

## Project structure

```
index.html          Entry point
src/
  styles.css        All styling
  parsers.js        GSTR JSON parsers
  tables.js         DOM table renderers
  xlsx-export.js    Formatted Excel workbook builder (ExcelJS)
  app.js            App logic, file handling
  booksrecon.js     Invoice-wise 2B vs books matcher
  books-ui.js       Books section: register loading, results
  tally-ui.js       Import from / send to Tally (via the extension)
  vendor/
    exceljs.min.js  Vendored ExcelJS browser bundle
```

## Hosting

Works as a static site — deploy to GitHub Pages, Vercel, Netlify, or any file host.

To enable GitHub Pages: go to repo Settings → Pages → Source: main branch, root folder.
