# GST Reconciliation Tool

A client-side web app for reconciling GSTR-1, GSTR-2B, and GSTR-3B returns. No data leaves your browser — everything is processed locally.

## Usage

1. Open `index.html` in a browser (or serve with any static host).
2. Upload your portal-downloaded JSON files for GSTR-1, GSTR-2B, and GSTR-3B.
3. Click **Run Reconciliation**.
4. Review the tables and download a CSV if needed.

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

## Project structure

```
index.html          Entry point
src/
  styles.css        All styling
  parsers.js        GSTR JSON parsers
  tables.js         DOM table renderers
  app.js            App logic, file handling, CSV export
```

## Hosting

Works as a static site — deploy to GitHub Pages, Vercel, Netlify, or any file host.

To enable GitHub Pages: go to repo Settings → Pages → Source: main branch, root folder.
