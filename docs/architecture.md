# Web architecture

## Runtime

Next.js App Router runs the UI and route handlers on Vercel. MongoDB Atlas is the only durable service. The Node.js runtime is used for MongoDB and password hashing; there is no Edge database access, worker or local filesystem dependency.

## Authentication and authority

The first successful `/api/setup` request acquires a database lock and creates the single Owner. Passwords are hashed with bcrypt. Successful login issues an eight-hour signed JWT in an HTTP-only, same-site cookie.

Permissions are enforced in API route handlers, not just hidden in the interface:

- Owner: every operation, including Admin creation.
- Admin: every daily operation, but cannot create/manage Owner or peer Admin accounts.
- Manager: POS, members, inventory, invoices, reports, purchase-order creation/approval/receiving and read-only team visibility.
- Accountant: dashboard, accounting, invoices, reports, purchasing entry and accounts-payable settlement; purchase approval remains separated.
- Cashier: dashboard, POS, members and inventory read access.

Sensitive mutations check same-origin requests and write an audit event.

## Register shifts

Register control is enabled independently for each counter when its first shift opens. From that point, sales and refunds on that counter require one open shift. Opening float and closing counts are recorded by physical currency, while sales and payment-method summaries remain in the immutable ledger currency.

Closing uses a blind cash count: expected cash is calculated on the server after submission from the opening float, shift-linked cash sales and shift-linked cash refunds. A non-zero variance closed by a Cashier enters `PENDING_REVIEW`; the counter cannot reopen until a Manager, Admin or Owner records a review explanation. A balanced close, or a close performed by a reviewer, produces a final immutable Z report.

Sales/refunds and closing update the same shift record inside their MongoDB transactions. This forces a write conflict when checkout races with close: the retry either includes the completed transaction in the report or rejects the transaction because the shift has closed.

## Operational exception reviews

`operationalReviews` is an append-oriented control queue populated in the same MongoDB transaction as a qualifying sale, refund, stocktake or register close whenever that workflow already uses a transaction. Negative manual stock adjustments and blocked-login incidents also emit a review after their primary control record is saved. Deterministic source/rule keys prevent duplicate queue entries.

Rules are deliberately transparent and deterministic: manual discounts at or above 10% of subtotal, cumulative refunds at or above 50% of the receipt, material inventory losses, any cash-count variance, and five failed sign-ins. Severity escalation is based on disclosed ratios or unit counts. These signals do not reverse transactions, lock accounts beyond the existing authentication throttle, or label activity as fraud.

Review updates use an optimistic integer version and append a named action/note to history. Register variances cannot be closed from the generic queue: the Manager must approve the source register shift, which atomically closes the shift and resolves its linked review. Authentication reviews retain only a derived incident identifier and never persist raw credentials, identities, IP addresses or message content.

## Location inventory and transfers

Legacy products continue using their existing company-wide `products.stock` until an authorized operator performs a one-time location allocation. The allocation must equal the current company total exactly and creates an `inventoryBalances` row for every active location. This gradual activation prevents an upgrade from silently assuming where historical stock is physically held.

Once a product is activated, every sale, refund, purchase receipt, manual adjustment and stocktake updates its location balance and company total in the same MongoDB transaction. POS catalogue reads use the selected counter's location balance, while financial inventory valuation continues using the company total. A location cannot be archived while it holds stock or participates in an in-transit transfer.

A transfer dispatch atomically reduces the source location and records the units as `IN_TRANSIT`; it does not change `products.stock` or post a financial journal because company ownership and inventory value are unchanged. Receipt adds all lines to the snapshotted destination, while cancellation restores all lines to the source. Stable client request IDs protect activation and dispatch retries; receive/cancel actions use optimistic versions. Transfer movements carry `affectsGlobalStock: false` so reclassification evidence cannot be mistaken for new stock.

## Batch and expiry inventory

Batch tracking is a second gradual, permanent activation layered on location inventory. Opening lots must reconcile to every location balance and the company total, and activation is blocked while the product has stock in transit. `inventoryBatches` uses a unique product/location/normalized-lot/expiry identity; `inventoryBatchActivations` and `inventoryBatchEvents` retain migration and adjustment evidence.

Purchase receipts create or extend supplier-provenanced lots. POS consumes unexpired lots using FEFO in the same transaction as the location and company stock reduction, and snapshots the allocations on the immutable sale. Refunds restore the exact next slice of those allocations. Transfer dispatch removes exact source lots and receipt/cancellation recreates the same identities at the destination/source without changing global stock or posting a journal. Batch counts update batch, location and global quantities atomically and use optimistic versions.

Expiry is stored as a date-only key and interpreted in the workspace time zone. Quantities past that date remain owned inventory until a controlled count or disposal removes them, but product reads for POS exclude them and checkout independently revalidates unexpired batch availability. The feature is operational traceability, not proof of food-safety certification or regulator acceptance.

Freshness forecasts aggregate 30 days of net sold units by product and location, allocate projected demand through live batches in FEFO order, and estimate at-risk units at each expiry date. Higher-demand destination suggestions are read-only advice and never dispatch a transfer. A controlled batch disposal atomically reduces batch/location/company quantities and, at the current weighted product cost, posts Inventory write-off (5100) against Inventory (1200). Forecasts are estimates; disposal remains an explicit authorised decision with a reason and optimistic batch version.

## POS transaction

A sale never trusts product prices from the browser. The API reloads products, calculates price, discount and GST on the server, then opens one MongoDB transaction. Inside it the application verifies stock, deducts quantities, writes stock movements, records the sale, awards member points, posts the balanced journal and writes the audit event. Any failure rolls everything back.

## Accounting policy in this release

- POS sales post Cash/Bank, Product sales, GST payable, Cost of goods sold and Inventory immediately.
- Customer invoice drafts and sent invoices do not post a journal.
- Marking an invoice paid posts Bank, Product sales and GST payable on a cash basis.
- Receiving an approved purchase order posts Inventory and recoverable input tax against Accounts payable in the business base currency.
- Settling a supplier bill debits Accounts payable and credits an approved cash/bank account; payment-time currency differences post to realised exchange gain or loss.
- Posted journals are append-only through the UI. Corrections should use a reversing journal.

Goods receipt, stock costing, AP bill creation and the receipt journal share one MongoDB transaction. Supplier payment, bill balance and its settlement journal share another. Stable client request IDs and unique supplier invoice numbers make retries idempotent.

This is an operational accounting/POS foundation, not a claim of parity with every AutoCount edition. Payroll, bank feeds, Singapore InvoiceNow/Peppol submission, advanced purchasing documents, serial-number tracking, year-end closing and statutory tax filing require dedicated later modules and compliance review.
