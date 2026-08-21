# Feature coverage and parity roadmap

This document prevents planned AutoCount-style modules from being confused with shipped functionality.

## Shipped and tested

- Owner setup, RBAC, team lifecycle, forced password change and session revocation
- Owner transfer cooling period and workspace open/read-only/closed controls
- Members, protected identity lookup, renewable printable member cards and points
- Products, barcode/SKU scanning, stock movements, archive/restore and low-stock indicators
- POS, tenders, trusted coupons/manual discounts, tax calculation and transactional posting
- Custom invoice and receipt templates, print/reprint, refund and historical snapshots
- Manual journals, chart of accounts and core management reports
- 24-hour token-restricted phone scanner passes compatible with Vercel serverless

## Next accounting modules

- Supplier, purchase order, goods receipt and accounts-payable workflow
- Customer statements, credit limits, quotations, delivery orders and recurring invoices
- Bank import/feed, reconciliation and cash-flow forecast
- Fixed-asset register, depreciation and disposal journals
- Expense claims, approvals, attachments and payment runs
- Multi-location stock transfer, batch/lot/expiry, serial number and stocktake
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
