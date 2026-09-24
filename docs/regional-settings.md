# Main country and regional settings

## Setup and ongoing operation

- New Owner setup requires an explicit country/region and base accounting currency. No country is preselected.
- Settings → Main country & regional settings supports 249 countries/regions, name/code search, date/number-format preview, editable IANA time zone, tax label/rate and accepted payment currencies.
- Country suggestions are starting points, not legal or tax advice. A country can have several currencies, languages or time zones. Check the local time zone; Antarctica has no suggested national currency.
- Choosing a different country resets the proposed tax rate to zero for explicit review. No tax rates, tax registrations or statutory filing eligibility are inferred from the country.
- The UI language remains English. Locale changes date/number formatting, not translations.
- The base accounting currency is fixed at ledger creation. Main country, business time zone, locale and accepted settlement currencies remain editable. A different ledger currency requires a separate ledger or a reviewed data migration; relabelling existing inventory, balances and journals is not currency conversion. The API rejects such relabelling with a JSON 409 and a field-level explanation.
- New headquarters use the setup profile; new locations inherit the current main profile. Existing locations retain their independently configured details.
- Old receipt/invoice business and template snapshots are not rewritten. Untouched legacy starter-template Singapore headers are neutralized when the country changes; customized template text is preserved.

## Calculation and date semantics

- Dashboard day/month/seven-day summaries follow the configured business time zone, including DST. Calendar dates are not derived from a fixed UTC offset.
- Invoice due dates and manual journal posting dates are calendar dates, not time-zone-shifted timestamps. Older manual journal dates stored at UTC midnight retain their calendar-day meaning in reports.
- Amounts in POS, product prices, coupon discounts, refunds and manual journals use currency-specific decimal precision. Manual journals reject excessive decimal places and balance in integer minor units.
- Template previews recalculate sample prices/taxes/change in the current business profile. Sample catalogue prices are examples, not currency-converted market prices; seeding them is opt-in.
- Reporting by a newly selected time zone can regroup past timestamp-based activity into different local dates. Underlying transaction timestamps and issued document snapshots remain unchanged.

## Offline reference data

The application makes no runtime calls for country configuration. `lib/country-data.ts` is generated from:

- [IANA tzdb 2025b country codes](https://data.iana.org/time-zones/tzdb-2025b/iso3166.tab) and [zone.tab](https://data.iana.org/time-zones/tzdb-2025b/zone.tab), public domain.
- [Unicode CLDR 48 currency data](https://raw.githubusercontent.com/unicode-org/cldr-json/48.0.0/cldr-json/cldr-core/supplemental/currencyData.json) and [likely subtags](https://raw.githubusercontent.com/unicode-org/cldr-json/48.0.0/cldr-json/cldr-core/supplemental/likelySubtags.json), under the accompanying `UNICODE-LICENSE.txt`.

The extraction date is pinned to 2026-09-12. `scripts/country-data.mjs` prints the reproducible extracted rows and licence; it never reads deployment secrets. Updates to legal currencies or time zones require a reviewed catalogue update. Do not present these reference defaults as certified country packs.

Regional selection does not automatically create a certified country rules pack. Payroll and fully controlled entity consolidation are available as reviewed accounting workflows; Malaysia also has an explicit Owner-controlled MyInvois connector. Statutory payroll formulas, automatic tax-return filing, other national e-invoice networks and every jurisdiction-specific disclosure remain outside the generic regional profile.

## Reproducible acceptance checks

- `npm test` covers country data, regional defaults, calendar/DST boundaries, currency precision, partial coupon updates and setup field whitelisting.
- `npm run build` checks the deployable Next.js pages and API routes.
- `scripts/regional-ui-smoke.cjs` exercises the real setup page plus an explicitly mocked SettingsView in desktop/mobile browsers. It requires a running local development server and a directory containing Playwright as its argument. These UI fixtures do not access a database.
- For real API/browser acceptance, install the optional `mongodb-memory-server@10` test tool with `npm install --prefix .artifacts/regional-mongo --no-audit --no-fund mongodb-memory-server@10`. Then, after building, run `node scripts/regional-local-smoke.cjs <directory-containing-playwright>`. The runner starts a loopback-only MongoDB replica set, uses real Owner setup and a fresh guarded collection namespace, tests sales/coupon lifecycle/invoices/refunds/journals/reports/country changes, and removes its temporary data on exit. Atlas or Vercel credentials are not needed. The initial download and local database require free disk space.
- Optional tools, screenshots and database binaries stay in ignored `.artifacts/` and are explicitly excluded from Vercel uploads. No test database, service or background job is added to the production application.

Invoice workflow details are documented in the application README: draft edits recalculate using the saved invoice tax context, while a new copy is a separate draft and never rewrites the source document.
