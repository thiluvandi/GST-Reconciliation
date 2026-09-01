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

Adds: `b2b`, `impg`, `impgsez`  
Subtracts: `cdnr` (credit notes)

## GSTR-3B fields used

- Outward liability: `sup_details.osup_det`
- ITC claimed: `itc_elg.itc_avl`

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
  vendor/
    exceljs.min.js  Vendored ExcelJS browser bundle
```

## Hosting

Works as a static site — deploy to GitHub Pages, Vercel, Netlify, or any file host.

To enable GitHub Pages: go to repo Settings → Pages → Source: main branch, root folder.
