# Sample data

The one folder for example data that isn't code: files you can upload by hand,
templates for the pilot, and the inputs the dev seeder and tests read.

- `csv/` holds review exports you can upload through the app's CSV import, one
  file per business or business type, named after the business
  (`<business-name>.csv`).
- `takeout/` holds a synthetic Google Takeout Business Profile export in the
  assumed shape read by `scripts/test-takeout-import.ts` and the onboarding
  browser walkthrough. The real export format is unverified; see
  [docs/integrations.md](../docs/integrations.md#google-takeout-review-import-233--format-unverified-checked-2026-11-05).
- `pilot/` holds the synthetic pilot ledger used as a template in
  [docs/pilot.md](../docs/pilot.md) and read by `scripts/test-pilot.ts`.

`npm run dev:seed` loads every file in `csv/` that it lists in
`scripts/seed/fixtures.ts` through the real CSV import, so the drafts it creates
quote these reviews. If you change a review there, check the seeded drafts that
quote it. See [docs/development.md](../docs/development.md#demo-flow-with-synthetic-data).

**Everything here is invented.** The reviews and reviewer names are fictional and
only exist to exercise the app. Never publish a post made from sample reviews,
and never mix real customer reviews into these files. Real reviews belong in the
owner's own import, not in the repository.

## CSV format

Required columns: `rating` (1-5), `text`, `reviewed_at` (ISO 8601). Optional:
`author_name`, `source_review_id`, `source_url`. The sample files fill
`source_review_id` with a `sample-<business>-NNN` id so a re-import is
recognised as duplicates instead of adding rows. Limits: 1 MB, 1000 rows; see
[docs/features.md](../docs/features.md#csv-review-import).

## Files

| File | What it is |
|---|---|
| `csv/hespeler-powder-coating.csv` | Hespeler Powder Coating, Cambridge, ON: sandblasting, powder coating and machine shop (24 reviews, ratings 2-5) |
| `csv/copper-kettle-cafe.csv` | Copper Kettle Café, an invented neighbourhood café (21 reviews, ratings 1-5, `sample-cafe-NNN`) |
| `csv/harbour-bike-repair.csv` | Harbour Bike Repair, an invented bike shop (17 reviews, ratings 2-5, `sample-bike-NNN`) |
| `takeout/reviews.json` | A synthetic Google Takeout Business Profile `reviews.json` (four reviews, enum and numeric ratings, one without an ID) |
| `pilot/pilot-synthetic.json` | Example pilot ledger entries for synthetic businesses |

The "download a sample" file in the app's onboarding is separate on purpose:
`public/onboarding-example.csv` is served by the web app, so it has to stay under
`public/`.

## Quote-card designs in the dev seed

The seeder assigns one design to each demo business so all four render in the app:
Copper Kettle Café (Pro) uses Spotlight, Copper Kettle Café Riverside (Business)
uses Framed, Hespeler Powder Coating (Business) uses Split, and Harbour Bike Repair
(Free) uses Classic, the only design Free includes. The Riverside business
intentionally reuses the café reviews; nothing about it represents a real second
location.
