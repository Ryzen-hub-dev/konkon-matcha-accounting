# Feature coverage and parity roadmap

This document prevents planned AutoCount-style modules from being confused with shipped functionality.

## Shipped and tested

- Owner setup, RBAC, team lifecycle, forced password change and session revocation
- Owner transfer cooling period and workspace open/read-only/closed controls
- Members, protected identity lookup, renewable printable member cards and points
- Products, barcode/SKU scanning, stock movements, archive/restore and low-stock indicators
- Physical stocktake with scan-to-count, typed final counts, transactional variance posting and audit history
- POS, tenders, trusted coupons/manual discounts, tax calculation and transactional posting
- Custom invoice and receipt templates, print/reprint, refund and historical snapshots
- Manual journals, chart of accounts and core management reports
- 24-hour token-restricted phone scanner passes compatible with Vercel serverless
- Low-latency auto-connected POS/Inventory scanner bridge with native + ZXing camera decoding
- QR/link-based phone connection and active POS/Inventory routing, including new-product barcode capture
- Cashier-scoped POS browser drafts/history and live member-list refresh without a full POS reload
- Separate 24-hour customer payment-screen passes with Welcome/Thank You states, POS-synchronised DuitNow MYR amount locking, CRC regeneration and mandatory receiving-side settlement confirmation
- Country, locale, IANA time-zone, base/accepted-currency and immutable settings history
- Locked foreign-exchange rates with base/tender sale snapshots and currency-aware rounding
- Provider-verified transfer/wallet foundation with signed callbacks, replay protection, exact payment matching and one-time consumption
- Dual local Android payment-notification adapters for SmsForwarder and notify-me, with USB-only loopback transport, local privacy filtering, deduplication and a MongoDB review queue that cannot auto-settle sales
- Multi-country headquarters, branch, warehouse and franchise hierarchy with cycle/archive safeguards
- Administrator-defined payment methods with reference/provider controls, settlement currencies and ledger-account routing
- Supplier master data with country/currency, commercial terms, archive/restore and protected historical references
- Purchase order draft, maker-checker approval, cancellation, partial receiving and location/supplier/product/time-zone snapshots
- Transactional goods receipts that update stock, weighted-average cost, AP, input tax, journals and audit history together
- Supplier bills, partial/full settlement, duplicate-post protection and realised foreign-exchange gain/loss posting
- Smart Replenishment recommendations using stock thresholds, 30-day demand, supplier lead time and open inbound quantities
- Supply Pulse supplier-performance scoring using delivery punctuality and overdue commitments

## AutoCount comparison baseline (reviewed 22 August 2026)

AutoCount does not publish one honest, edition-independent “total feature count.” Its official Accounting pages state that there are up to 15 document-entry types and more than 1,000 report combinations, while editions, POS and add-ons provide different sets. Treating those report combinations as 1,000 separate software functions would be misleading.

For a reproducible comparison, this project counts the 72 individual entries in AutoCount's official POS “Features Summary” once each. Against that fixed POS list, the current Kōn-Kōn web application has:

- 38 fully covered entries
- 4 partially covered entries
- 30 not yet covered entries
- 42 of 72 entries with at least partial coverage (58.3%)

Breakdown by the official POS headings:

- Receipt printing: 5 full, 1 partial, 1 missing
- Transactions: 3 full, 0 partial, 7 missing
- Data entry: 3 full, 2 partial, 6 missing
- Multiple payment methods: 1 full, 0 partial, 0 missing
- Routine operation: 2 full, 0 partial, 3 missing
- Back-end maintenance: 11 full, 1 partial, 3 missing
- POS reports: 9 full, 0 partial, 5 missing
- Stock reports: 4 full, 0 partial, 5 missing

“Partial” is used when the safe web workflow covers only part of the named desktop feature—for example quantity changes without per-line price override, or scanner-pass terminal control without full multi-outlet terminal maintenance. The comparison source is AutoCount's [official POS feature summary](https://member.autocountsoft.com/products/ac_pos/helpfile/pos_introduction.htm). The wider roadmap is also checked against the [official AutoCount Cloud Accounting feature and plan page](https://www.autocountsoft.com/pro-cloud-acc.html) and the [official Accounting feature pages](https://member.autocountsoft.com/products/ac_accounting/info/features1.aspx).

This count is a delivery benchmark, not a claim of AutoCount parity. Accounting, country compliance and optional plug-ins are tracked below and must pass their own acceptance tests before being counted as shipped.

## Next accounting modules

- Purchase requisitions, RFQs, quotation comparison, purchase returns, landed cost and three-way matching exceptions
- Customer statements, credit limits, quotations, delivery orders and recurring invoices
- Bank import/feed, reconciliation and cash-flow forecast
- Fixed-asset register, depreciation and disposal journals
- Expense claims, approvals, attachments and payment runs
- Multi-location stock transfer, batch/lot/expiry and serial-number tracking
- Multi-company consolidation, intercompany journals and elimination entries
- Payroll, leave, statutory contribution and employee self-service
- Budgeting, dimensions/cost centres, projects and variance reporting

## Country packs

A filing-ready country pack must include versioned tax codes/rates, chart templates, fiscal-calendar rules, rounding, statutory report layouts, e-invoice schemas, export validation and official-source metadata. It must also include regression fixtures and a qualified local-accountant sign-off date.

Until that lifecycle exists, the UI must call outputs “management reports,” never “certified tax returns.” Singapore is the first planned pack; other countries must be installed as separately versioned packages rather than hard-coded conditionals.

## Independent features planned

- Matcha batch provenance from supplier lot to receipt line
- Ceremonial-grade freshness/expiry forecast tied to demand and wastage
- Brew recipe costing and margin simulation
- Member taste profile and consent-controlled recommendations
- Anomaly review queue for unusual discounts, refunds, inventory shrinkage and login behaviour
