<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project memory

## Product

- Kōn-Kōn Matchā Ledger is an operational accounting, inventory, purchasing, membership, and point-of-sale workspace for Kōn-Kōn Matchā.
- The production product is the root Next.js App Router application. It is designed for Vercel serverless deployment with MongoDB Atlas as the only durable service.
- `clients/KonkonMatcha.Client` is the shared .NET MAUI Windows/Android shell around the web workspace. It must not duplicate business or authorization logic.
- `MatchaAccounting/`, `api/`, `deploy/`, and `sql/` are preserved WPF/PHP-era prototype or deployment artifacts. Do not treat them as the current application unless a task explicitly targets them.

## Current functional boundary

- Shipped areas include Owner/team security and RBAC, multi-counter POS, receipts/refunds, products, stocktakes, multi-location transfers, batch/lot/expiry control, freshness forecasting and inventory disposal/write-off, members/QR/NFC credentials, coupons, configurable payments and currencies, quotations, customer delivery orders, invoices, customer credit controls/statements, journals/reports, CSV bank reconciliation, suppliers/purchase orders/accounts payable, scanner/payment display passes, regional settings, audit, and retention controls.
- Electronic-invoice work currently prepares, encrypts, and retains UBL/accounting/MyInvois files. It does not submit to a tax authority, provide a digital signature, or prove authority acceptance.
- Country reports are management reports and working papers, not certified returns. Payroll, live bank feeds/rules, fixed assets, consolidation, complete statutory filing, and several advanced purchasing/stock workflows remain future work.
- `README.md` is the product overview, `docs/architecture.md` defines the runtime and accounting policy, and `docs/feature-coverage.md` is the source of truth for shipped-versus-planned scope.

## Architecture and invariants

- The active stack is Next.js 16 App Router, React 19, TypeScript, MongoDB, Zod, signed HTTP-only cookie sessions, and server-enforced RBAC.
- UI visibility is never the authorization boundary. Mutating route handlers must keep permission checks, same-origin protection where applicable, safe public errors, validation, and audit evidence.
- POS prices and totals are calculated on the server. Checkout atomically covers stock, sale, member points, coupon use, journal posting, and audit data. Purchasing receipt/AP and supplier-payment workflows likewise rely on MongoDB transactions and idempotency.
- Preserve historical snapshots and append-only financial evidence. Corrections use explicit refunds/reversals or new records rather than silently rewriting issued documents or posted journals.
- Keep secrets and sensitive member/payment data server-side. Do not expose full private identifiers, raw bearer credentials, webhook secrets, database credentials, or private payment references.
- The accounting currency is fixed once the ledger exists; changing country/locale/time zone must not relabel historical money.
- MongoDB runs with Stable API V1 strict mode on Atlas M0-compatible commands. Optional unique fields use partial indexes rather than `sparse`, and distinct-value reads use `$group` aggregation rather than the non-Stable-API `distinct` command; legacy sparse indexes are migrated only after the replacement constraint exists.
- The database index baseline is guarded by the durable `schemaMigrations` marker in `lib/db.ts`, so a Vercel cold start performs one lightweight version lookup instead of recreating every index. Bump `INDEX_SCHEMA_VERSION` whenever an index definition changes.
- Customer credit is enforced only when a linked draft becomes `SENT`. The check, invoice status change, decision snapshot and shared-member write stay in one transaction so concurrent sends cannot exceed a limit through write skew. Statements exclude drafts and voids and do not prove external settlement.
- Quotation states are forward-only internal evidence, not email-delivery or electronic-signature proof. Only an accepted quotation can convert, and the transaction plus unique `sourceQuoteId` index creates at most one invoice draft while preserving quoted money/tax snapshots.
- Customer delivery orders are quote-linked, forward-only operational evidence. One full delivery order is allowed per quotation; dispatch/delivery does not move stock, post accounting, record payment or independently prove carrier/customer receipt.
- Bank reconciliation imports local CSV statements only. Suggestions never auto-confirm; unique match records prevent reusing statement or ledger lines, completion requires a zero difference, and the locked working paper snapshots prior/current uncleared evidence without claiming a live bank connection or settlement proof.
- Never describe a QR display, payer animation, local notification, or prepared e-invoice file as proof of settlement or government submission.

## Working conventions

- Before changing Next.js code, read the relevant local guide under `node_modules/next/dist/docs/` as required above.
- Prefer changes in root `app/`, `components/`, and `lib/`; touch legacy directories only when the requested scope names them.
- Preserve the standard API envelope: `{ "ok": true, "data": ... }` or `{ "ok": false, "error": ..., "issues"?: ... }`.
- Minimum checks for normal TypeScript changes are `npm run typecheck` and `npm test`; use `npm run build` and the targeted smoke suites when the change affects integration, rendering, deployment, or browser/device behavior.

## Last synchronized baseline

- On 2026-09-18, the repository was on `main` with a clean worktree before this memory update.
- `npm run typecheck`, `npm test` (149 tests), and the Webpack production build (58 generated pages) passed after the register-shift, exception-review, multi-location transfer, batch/expiry, freshness-forecast, inventory-disposal, MongoDB Atlas M0/Stable API compatibility, serverless cold-start performance, customer-account credit controls, quotation-to-invoice, quote-linked delivery-order, and controlled CSV bank-reconciliation upgrades. On this Windows host, the successful build used `KONKON_DISABLE_WEBPACK_CACHE=1` after Webpack's optional pack cache hit a filesystem write error.
