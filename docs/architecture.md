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

## Bank reconciliation controls

Bank reconciliation imports a local CSV working copy; it does not connect to a bank or prove settlement. The server validates an unambiguous statement period, base-currency precision, and that opening balance plus imported movements equals the stated closing balance. Only active cash-equivalent asset accounts are eligible, and one open draft plus non-overlapping statement periods are enforced per account.

Matching is server-controlled and transactional. Exact amount/date proximity can preselect a suggestion, but a staff member must confirm it. Unique match records prevent either a statement row or posted journal line from being reused, and optimistic versions prevent two browser sessions from overwriting each other. Ledger entries remain append-only.

Completion requires every imported row to be matched and the adjusted statement balance to equal the ledger closing balance. The completed record snapshots the opening difference, prior items cleared, current-period uncleared entries, reviewer note and zero difference. It is then immutable and remains readable without recalculating against later ledger activity. Live bank feeds, provider credentials, bank rules, automatic voucher creation and cash-flow forecasting are later phases.

## Month-end close and posting lock

Only a completed calendar month can close. The close transaction rechecks posted-journal balance integrity and requires a completed bank reconciliation covering every non-cash bank account used during that month; overlapping bank-reconciliation drafts remain blockers. The locked record snapshots journal counts and totals, bank coverage, reviewer identity, note and time. Read views compare that snapshot with the live ledger and flag out-of-band database or legacy writes.

The lock is not a UI convention. Manual journals, POS sales and refunds, invoice payments, purchase receipts, supplier payments and inventory-disposal journals all touch the same accounting-period record inside their existing MongoDB transaction before changing business data. Closing and posting therefore create a write conflict; transaction retry sees the new closed state and rejects a late back-dated post instead of allowing check/write skew. Only the Owner can reopen, a reason is audited, and later closed periods must be reopened first. Reopening does not erase the earlier close snapshot or action history.

## Fixed assets and book depreciation

The fixed-asset register keeps cost, residual value, useful life, service date, category, serial/location/custodian data and a snapshot of its configured ledger accounts. A new cash/bank purchase debits the asset-cost account and credits an approved cash-equivalent account in the same transaction as registration. `REGISTER_ONLY` is an explicit migration path: it stores opening accumulated depreciation and the last covered month but does not recreate or claim an acquisition journal.

Depreciation uses straight-line, full-service-month book policy. The depreciable amount is divided in currency minor units so every monthly allocation is exact and the schedule cannot accumulate rounding drift. Runs are sequential per asset, idempotent, limited to the current or a prior month and consolidated by expense/accumulated-depreciation account into one balanced journal. The asset update, monthly evidence rows, run record, journal and audit event commit together. Month-end close counts any asset still due through the selected month as a blocker and retains that count in the immutable close snapshot.

Disposal requires depreciation through the disposal month. Its transaction removes historical cost, reverses accumulated depreciation, records cash/bank proceeds, posts the balancing gain or loss, locks the asset status and stores an immutable disposal snapshot. Closed accounting periods reject acquisition, depreciation and disposal postings. These are management-book calculations; tax capital allowances, impairment/revaluation, component accounting, asset transfers and certified tax schedules remain separate work.

## Customer credit and statements

An invoice can optionally retain a member ObjectId and member-number snapshot as its customer-account link. A draft does not consume credit. When a linked draft is marked `SENT`, the server reloads the active member, totals every other open invoice in the immutable ledger currency, enforces any configured limit or hold, and saves the reviewed exposure and control values on the invoice. The same transaction touches the shared member record so concurrent sends for one customer create a write conflict and retry the full exposure calculation instead of both passing on stale totals.

Credit-control changes require invoice-write permission, a same-origin request, an optimistic member version and a reason recorded in audit evidence. A blank limit means no configured ceiling; zero prevents new account-credit invoices. Holds block new sent credit but do not rewrite issued documents or prevent recording an immediate full payment.

Customer statements are derived from issued and paid invoice snapshots. Drafts and void invoices do not affect the balance, and a recorded payment appears as its own chronological line. Statements are management records; they do not independently prove bank settlement.

## Customer quotation lifecycle

Quotation drafts use the same server-side amount, currency precision and tax calculator as invoices, but retain their own business/customer/item snapshot and validity date. Only a draft can be edited. Recording `SENT` locks the commercial snapshot; subsequent actions move forward to `ACCEPTED`, `REJECTED`, `VOID` or a derived `EXPIRED` display state. Acceptance and rejection require an operator note. These states are internal evidence of what staff recorded and are not an email-delivery receipt, electronic signature or independent proof of customer consent.

Only an accepted quotation can convert. Conversion runs in a MongoDB transaction, creates one invoice draft with the quoted currency/tax/line snapshots and default paper template, stores the source quotation reference on that invoice, and marks the quotation `CONVERTED`. A unique source-quotation index plus retry handling prevents duplicate invoices. Conversion does not post accounting or consume credit; the normal invoice credit check still runs when the resulting draft is marked `SENT`.

## Customer delivery-order lifecycle

An `ACCEPTED` or `CONVERTED` quotation can create one full delivery-order draft. Creation runs in a transaction, copies the customer, business and item snapshot, links the new record back to the quotation, and uses both a request key and a unique source-quotation index to make retries safe. The draft holds its own scheduled date, destination, contact, carrier, tracking reference and instructions; only those logistics fields remain editable.

Delivery states move forward from `DRAFT` to `DISPATCHED` and `DELIVERED`, or from an open state to `CANCELLED`. Every transition requires an optimistic version and an operator note; delivery completion also records who the operator says received it. A linked open delivery order prevents its accepted source quotation from being voided. These records do not allocate batches, deduct stock, post accounting, record payment, send carrier instructions or independently prove dispatch or customer receipt. Partial deliveries, stock-affecting fulfilment and attachment-based proof remain later workflows.

This is an operational accounting/POS foundation, not a claim of parity with every AutoCount edition. Payroll, live bank feeds, Singapore InvoiceNow/Peppol submission, advanced purchasing documents, serial-number tracking, year-end retained-earnings processing and statutory tax filing require dedicated later modules and compliance review.
