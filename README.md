# Alpha QA — Inspection Board

Staff calendar: who inspects, 1 or ½ day, factory, customer, inline vs final.

**Live board:** https://tranchaungoclong-tech.github.io/Alpha-QA-Board/

## How the team uses it

1. PIC fills the **Google Form** on the phone (travel).
2. Wait 1–2 minutes.
3. Open / refresh this Pages URL.

Do **not** edit this GitHub repo to add inspections. GitHub only hosts the page. Live rows come from the published Form Responses CSV.

## Files

| File | Role |
| --- | --- |
| `index.html` | Board (v49 — ALERT ON; 15 min repeats; top-right job card + fading chime) |
| `sheet-config.js` | Published CSV URL + Form URL |
| `sw.js` / `manifest.json` | Offline cache of the last visit |
| `SHEET.md` | Form → CSV → Pages |

Anyone with the CSV URL can read the log. Keep secrets out of the Sheet.
