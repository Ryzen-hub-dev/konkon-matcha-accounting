# Web architecture

## Runtime

Next.js App Router runs the UI and route handlers on Vercel. MongoDB Atlas is the only durable service. The Node.js runtime is used for MongoDB and password hashing; there is no Edge database access, worker or local filesystem dependency.

## Authentication and authority

The first successful `/api/setup` request acquires a database lock and creates the single Owner. Passwords are hashed with bcrypt. Successful login issues an eight-hour signed JWT in an HTTP-only, same-site cookie.

Permissions are enforced in API route handlers, not just hidden in the interface:

- Owner: every operation, including Admin creation.
- Admin: every daily operation, but cannot create/manage Owner or peer Admin accounts.
- Manager: POS, members, inventory, invoices, reports and read-only team visibility.
- Accountant: dashboard, accounting, invoices and reports.
- Cashier: dashboard, POS, members and inventory read access.

Sensitive mutations check same-origin requests and write an audit event.

## POS transaction

A sale never trusts product prices from the browser. The API reloads products, calculates price, discount and GST on the server, then opens one MongoDB transaction. Inside it the application verifies stock, deducts quantities, writes stock movements, records the sale, awards member points, posts the balanced journal and writes the audit event. Any failure rolls everything back.

## Accounting policy in this release

- POS sales post Cash/Bank, Product sales, GST payable, Cost of goods sold and Inventory immediately.
- Customer invoice drafts and sent invoices do not post a journal.
- Marking an invoice paid posts Bank, Product sales and GST payable on a cash basis.
- Posted journals are append-only through the UI. Corrections should use a reversing journal.

This is an operational accounting/POS foundation, not a claim of parity with every AutoCount edition. Payroll, bank feeds, Singapore InvoiceNow/Peppol submission, supplier purchasing, multi-warehouse transfers, year-end closing and statutory tax filing require dedicated later modules and compliance review.
