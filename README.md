# Kōn-Kōn Matchā Ledger

A matcha-branded accounting, inventory, membership and point-of-sale workspace built for Kōn-Kōn Matchā. The production application is a Next.js App Router project backed by MongoDB Atlas and designed for Vercel serverless deployment.

> This is an actively developed accounting platform, not yet a drop-in replacement for every AutoCount module. The repository clearly separates shipped, tested workflows from planned country-compliance modules so unfinished tax functionality is never presented as filing-ready.

## Shipped workflows

### Owner, team and security

- First-run Owner setup; Owner is the highest role.
- [Private Owner replacement](docs/owner-recovery.md): operator-issued, 24-hour, single-use registration link; preserves the team and all business records, without reopening public setup.
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
- Optional downloadable USB-local SmsForwarder + notify-me payment evidence listener: signed/token-authenticated ingress, OTP and outgoing-message rejection, raw-text disposal, dual-delivery deduplication and a review-only MongoDB queue. It never marks a sale paid by itself.
- Separate customer-facing phone display passes with Welcome/Thank You states. TNG/DuitNow recipient QRs are validated, locked to the exact POS MYR amount and issued with a recalculated CRC; a display state or payer animation never replaces receiving-side confirmation.
- Cashier-scoped browser order recovery and bounded draft history across refreshes and page changes; sensitive payment references and verification codes are not cached.
- Idempotent checkout requests prevent a network retry from creating a second receipt or double-deducting stock.
- Manager-only manual discounts; Cashiers cannot submit arbitrary discount values.
- Percentage and fixed coupons with start/end time, minimum spend, total-use limit and per-member limit.
- Transactional stock deductions, member points, coupon redemption and double-entry posting.
- Custom 58mm/80mm receipt templates, safe raster logos, privacy-first address-hidden defaults, print/reprint and refund workflow.
- Historical receipt/template/business snapshots so reprints do not change later.
- Receipt-number/QR lookup, signed customer receipt links, PDF printing, CSV and accounting JSON export; customer views show current refund totals without exposing member identity, staff names, costs or private payment references.
- Click a cart quantity to enter an integer directly; both cart and checkout enforce available stock and the 999-unit line limit.

### Barcode and mobile scanning

- Optional unique barcode on each product; products without manufacturer codes remain supported.
- USB/Bluetooth keyboard-wedge scanner input in Inventory and POS.
- Receipt and member screens also accept scans. A receipt QR scanned at POS opens that receipt for review; a member QR/NFC credential selects its active member.
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
- Independently issued QR/NFC member cards with editable label, membership title and colour; suspend, reactivate, permanently void and audit-preserving delete controls.
- Random card credentials, SHA-256 lookup hashes and AES-256-GCM encrypted storage. No name, phone or identity number is written to an NFC tag. Sensitive receipt/member scanner events are encrypted until TTL expiry.
- Phone-based NDEF reading/writing on supported Android Chrome devices, with QR fallback elsewhere. Static tags are copyable identification credentials, not payment authorization or clone-resistant smart cards. See [receipt and NFC guide](docs/receipts-and-nfc.md).

### Inventory and accounting

- Product create/edit, optional barcode, SKU, category, unit, retail price, cost and reorder level.
- Stock adjustment journal with mandatory reason.
- Physical stocktake with typed or scan-to-count quantities, variance posting and auditable stock movements.
- Product archive/restore preserving stock and transaction history.
- Manual balanced journals and a seeded chart of accounts.
- Searchable main-country settings for 249 countries/regions, editable date/number format and time zone, and explicit country selection during Owner setup.
- Local-day/month dashboard statistics, calendar-safe invoice due dates and manual journals, and currency-specific precision for product prices, coupons, POS and refunds.
- Draft/sent/paid/void invoices with custom uploadable JSON templates and printable documents.
- Invoice register search and status filters, explicit sent/paid/void confirmations, safe copy-as-new-draft, and optimistic-concurrency editing for unpaid drafts. Retried creates carry an idempotency key; issued and paid documents remain immutable.
- Sales, margin, tender, inventory-value and receivable reports.

### Purchasing and accounts payable

- Auditable supplier master records with country, currency, tax/registration details, terms, lead time and archive/restore controls.
- Draft, maker-checker approve, cancel and partially receive purchase orders with immutable supplier, product, location, time-zone, tax and exchange-rate snapshots.
- Atomic goods receipt posting: stock, weighted-average cost, stock movement, supplier bill, input tax, accounts payable, journal and audit event succeed or roll back together.
- Duplicate-request and duplicate-supplier-invoice protection prevents double receipts, duplicate inventory and repeated payables.
- Partial/full supplier settlement from approved cash/bank accounts with unique bank-reference protection, payment-time FX rates and automatic exchange-gain/loss journals.
- Smart Replenishment combines reorder thresholds, trailing 30-day unit demand and supplier lead time, then deducts quantities already inbound on open purchase orders.
- Supply Pulse scores suppliers from actual on-time receipts, average lateness and overdue commitments.

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
- `/api/scanner-sessions`, `/api/mobile-scans`, `/api/payment-display-sessions`, `/api/payment-display`
- `/api/sales`, `/api/refunds`, `/api/receipt-templates`, `/api/payment-intents`, `/api/payment-confirmations`, `/api/local-payment-events`
- `/api/receipt-lookup`, `/api/public-receipts`, `/api/member-cards`, `/api/member-cards/lookup`
- `/api/invoices`, `/api/invoice-templates`, `/api/journals`, `/api/reports`
- `/api/suppliers`, `/api/purchase-orders`, `/api/accounts-payable`
- `/api/settings`, `/api/settings/history`, `/api/locations`

Workspace writes require a same-origin browser request and authenticated role permission. Initial setup, private owner recovery and token-restricted phone scan submission have their own authorization rules. Customer receipt retrieval is a read-only POST requiring the signed receipt token; it never authorizes refunds. Public errors do not include stack traces, secrets or database internals.

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

The current suite covers authentication errors, origin protection, RBAC, MongoDB namespace isolation, invoice/receipt template validation, currency precision, tax math, coupon bounds, scanner token/routing, provider webhook signatures and exact amounts, local-listener signatures/privacy filtering, POS draft recovery, franchise hierarchy safety, protected identity lookup normalization, procurement validation, smart replenishment, supplier risk scoring, weighted inventory costing, AP foreign-exchange settlement and system write-mode classification.

Invoice acceptance also covers impossible calendar dates, currency-safe line calculations, idempotent draft creation, unpaid-draft editing, template snapshot retention, optimistic version conflicts, immutable sent/paid transitions, payment journal posting and mobile invoice-register controls.

## Vercel Hobby design

- Node.js routes are short-lived and stateless; MongoDB owns durable scanner and transaction state.
- MongoDB client reuse is global per warm function instance with `maxPoolSize: 5`, `minPoolSize: 0` and idle cleanup.
- POS, Inventory, Receipts and Members automatically route the newest live phone pass to the active workflow. Each event snapshots its destination so simultaneous pages cannot consume the wrong scan. A bounded three-second wait returns scans in 250 ms slices, aborts when the page unmounts and pauses while the tab is hidden.
- TTL indexes automatically remove expired scanner sessions/events, authentication throttles and sensitive lookup events.
- No long-running server, filesystem persistence, WebSocket server or background worker is required.
- `vercel.json` pins functions to Singapore and enables Fluid Compute.

Vercel Hobby is intended for personal, non-commercial projects and pauses service after included usage is exhausted. Use it for development/testing; a live Kōn-Kōn commercial deployment should move to an appropriate paid plan and add production monitoring, backup validation and incident response.

See [docs/deployment-vercel.md](docs/deployment-vercel.md) and [SECURITY.md](SECURITY.md).

## Country tax/reporting boundary

The main country is configurable and new workspaces choose their country and accounting currency during setup. Existing workspaces can change the main country, locale and time zone without relabelling their fixed ledger currency or rewriting historical documents. Tax rate and tax-inclusive/exclusive pricing remain explicit settings. Generated reports are management reports; they are **not** automatically certified tax returns. See [regional settings](docs/regional-settings.md) for the currency-protection rules and offline data sources.

Country-pack installation, statutory forms, e-invoicing networks, payroll, bank feeds, fixed assets, consolidation and jurisdiction-specific electronic filing remain separate implementation phases. Each country pack must be versioned, sourced from the relevant tax authority and reviewed by a qualified local accountant before the UI can label it filing-ready. See [docs/feature-coverage.md](docs/feature-coverage.md).

## Legacy prototype

The preserved `MatchaAccounting/`, `api/`, `deploy/` and `sql/` folders contain the earlier WPF/PHP prototype. The deployed web application uses the root `app/`, `components/` and `lib/` folders.
