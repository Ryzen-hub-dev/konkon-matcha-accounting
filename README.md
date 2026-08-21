# Kōn-Kōn Matchā Ledger

A matcha-branded accounting, inventory, membership and point-of-sale workspace built for Kōn-Kōn Matchā. The production application is a Next.js App Router project backed by MongoDB Atlas and designed for Vercel serverless deployment.

> This is an actively developed accounting platform, not yet a drop-in replacement for every AutoCount module. The repository clearly separates shipped, tested workflows from planned country-compliance modules so unfinished tax functionality is never presented as filing-ready.

## Shipped workflows

### Owner, team and security

- First-run Owner setup; Owner is the highest role.
- Owner, Admin, Manager, Accountant and Cashier server-enforced permissions.
- Staff account generation with temporary passwords and mandatory password change.
- Self-service password change and administrator password reset.
- Versioned sessions: password, role, disable and archive changes revoke existing sessions.
- Reversible account disable plus audit-preserving archive (“delete”) controls.
- Owner-only 24-hour ownership-transfer cooling period with cancel/complete steps.
- Open, read-only and closed workspace modes with an optional automatic reopen time.
- Audit records for security, ownership, inventory, member, sale and configuration changes.

### POS, receipts and promotions

- Product cart, member selection, administrator-defined payment methods and optional/required payment references.
- Payment-method routing to an active cash/bank asset account, revalidated by the API and snapshotted on each sale for accurate refunds.
- Server-calculated prices, coupon discounts, tax, cash received and change due.
- Cash and non-cash settlement in configured ISO currencies using administrator-locked exchange rates, with base/tender amounts snapshotted on the receipt.
- Provider-verified transfer/wallet foundations with signed callbacks, replay protection, exact amount/currency matching and one-time confirmation consumption.
- Cashier-scoped browser order recovery and bounded draft history across refreshes and page changes; sensitive payment references and verification codes are not cached.
- Idempotent checkout requests prevent a network retry from creating a second receipt or double-deducting stock.
- Manager-only manual discounts; Cashiers cannot submit arbitrary discount values.
- Percentage and fixed coupons with start/end time, minimum spend, total-use limit and per-member limit.
- Transactional stock deductions, member points, coupon redemption and double-entry posting.
- Custom 58mm/80mm receipt templates, safe raster logos, print/reprint and refund workflow.
- Historical receipt/template/business snapshots so reprints do not change later.

### Barcode and mobile scanning

- Optional unique barcode on each product; products without manufacturer codes remain supported.
- USB/Bluetooth keyboard-wedge scanner input in Inventory and POS.
- A shared live scanner bridge recognises a product barcode/SKU, member card/member number or coupon code in POS.
- Inventory scans open an existing product editor or open a new product form with the new barcode already populated.
- Up to five active mobile-scanner passes per operator.
- Mobile pass contains a 256-bit random bearer token; MongoDB stores only its SHA-256 hash.
- Pass expires after 24 hours, can be revoked immediately and is invalidated whenever the Owner changes system mode.
- The public mobile page can only send codes. It cannot read the catalogue, member data, pricing or reports.
- Three-second bounded long polling lowers average delivery latency to roughly one polling slice (250 ms) without a persistent WebSocket server, remaining compatible with Vercel Hobby/serverless execution.
- Mobile camera decoding uses native multi-format detection where available and dynamically loads ZXing 1D/2D fallback support elsewhere; previously granted camera permission starts automatically.

### Members and data protection

- Member profile, phone/email, points, lifetime spend and service history.
- Printable Code 39 member card with a renewable random card code.
- Exact National ID/passport/business-ID search without storing or returning the full identifier.
- Identity values are normalized and protected with an `IDENTITY_LOOKUP_SECRET`-keyed HMAC; only the hash and last four characters are stored. `AUTH_SECRET` is a local-development fallback only.
- Protected identity lookup is rate-limited and audit logged.
- Member “delete” is an archive operation so invoices, receipts, points and audits stay referentially intact.

### Inventory and accounting

- Product create/edit, optional barcode, SKU, category, unit, retail price, cost and reorder level.
- Stock adjustment journal with mandatory reason.
- Physical stocktake with typed or scan-to-count quantities, variance posting and auditable stock movements.
- Product archive/restore preserving stock and transaction history.
- Manual balanced journals and a seeded chart of accounts.
- Draft/sent/paid/void invoices with custom uploadable JSON templates and printable documents.
- Sales, margin, tender, inventory-value and receivable reports.

## API contract

Every application endpoint returns JSON in one of these forms:

```json
{ "ok": true, "data": {} }
```

```json
{ "ok": false, "error": "Safe public message", "issues": { "field": ["Validation detail"] } }
```

Core endpoints:

- `/api/setup`, `/api/auth/login`, `/api/auth/logout`, `/api/profile`
- `/api/users`, `/api/system-control`, `/api/ownership-transfer`
- `/api/products`, `/api/stocktakes`, `/api/members`, `/api/coupons`, `/api/payment-methods`, `/api/exchange-rates`
- `/api/scanner-sessions`, `/api/mobile-scans`
- `/api/sales`, `/api/refunds`, `/api/receipt-templates`, `/api/payment-intents`, `/api/payment-confirmations`
- `/api/invoices`, `/api/invoice-templates`, `/api/journals`, `/api/reports`
- `/api/settings`, `/api/settings/history`, `/api/locations`

Write requests require a same-origin browser request and authenticated role permission, except the token-restricted mobile scan sender. Public errors do not include stack traces, secrets or database internals.

## Local development

Requirements: Node.js 20.9 or newer and MongoDB Atlas (or a compatible MongoDB replica set for transactions).

1. Run `npm install`.
2. Copy `.env.example` to `.env.local`.
3. Supply a new MongoDB URI, a random `AUTH_SECRET`, and different stable `IDENTITY_LOOKUP_SECRET` and `PAYMENT_WEBHOOK_SECRET` values, each at least 32 characters.
4. Run `npm run dev`.
5. Open `http://localhost:3000/setup` once to create the Owner.

Never commit `.env.local`. Any credential pasted into chat, screenshots, tickets or logs must be considered exposed and rotated.

## Quality checks

```text
npm run typecheck
npm test
npm run build
```

The current suite covers authentication errors, origin protection, RBAC, MongoDB namespace isolation, invoice/receipt template validation, currency precision, tax math, coupon bounds, scanner token/routing, provider webhook signatures and exact amounts, POS draft recovery, franchise hierarchy safety, protected identity lookup normalization and system write-mode classification.

## Vercel Hobby design

- Node.js routes are short-lived and stateless; MongoDB owns durable scanner and transaction state.
- MongoDB client reuse is global per warm function instance with `maxPoolSize: 5`, `minPoolSize: 0` and idle cleanup.
- POS and Inventory automatically route the newest live phone pass to the active workflow. Each event snapshots its POS/Inventory destination so simultaneous pages cannot consume the wrong scan. A bounded three-second wait returns scans in 250 ms slices, aborts when the page unmounts and pauses while the tab is hidden.
- TTL indexes automatically remove expired scanner sessions/events, authentication throttles and sensitive lookup events.
- No long-running server, filesystem persistence, WebSocket server or background worker is required.
- `vercel.json` pins functions to Singapore and enables Fluid Compute.

Vercel Hobby is intended for personal, non-commercial projects and pauses service after included usage is exhausted. Use it for development/testing; a live Kōn-Kōn commercial deployment should move to an appropriate paid plan and add production monitoring, backup validation and incident response.

See [docs/deployment-vercel.md](docs/deployment-vercel.md) and [SECURITY.md](SECURITY.md).

## Country tax/reporting boundary

The shipped workspace is configured for a Singapore-style SGD/GST ledger, but tax rate and tax-inclusive/exclusive pricing remain explicit settings. Generated reports are management reports; they are **not** automatically certified tax returns.

Country-pack installation, statutory forms, e-invoicing networks, payroll, bank feeds, fixed assets, purchasing/AP, consolidation and jurisdiction-specific electronic filing remain separate implementation phases. Each country pack must be versioned, sourced from the relevant tax authority and reviewed by a qualified local accountant before the UI can label it filing-ready. See [docs/feature-coverage.md](docs/feature-coverage.md).

## Legacy prototype

The preserved `MatchaAccounting/`, `api/`, `deploy/` and `sql/` folders contain the earlier WPF/PHP prototype. The deployed web application uses the root `app/`, `components/` and `lib/` folders.
