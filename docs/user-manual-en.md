# Kōn-Kōn Matchā Ledger Complete User Manual

Version: 2026-09-19  
Applies to: the online Next.js workspace, Vercel deployment and shared Windows/Android shell  
Audience: Owners, Admins, Managers, Accountants, Cashiers and user trainers

> This manual supports daily operation and internal-control training. Country reports, tax figures and electronic-invoice outputs are currently management working papers, not certified filings or tax-authority acceptance.

## 1. Quick start

### 1.1 First sign-in

1. Open the workspace URL supplied by the company.
2. Enter your personal username and temporary password.
3. Create a new password immediately when prompted. Do not reuse another service's password.
4. Use the left navigation; on a phone, open the menu first.
5. The top bar identifies the current page and the footer shows the company, book currency and time zone.
6. Sign out from the bottom-left user control when work is complete.

If a menu is missing, the current role normally lacks permission. Do not borrow an account; ask an Owner or Admin to review the role.

### 1.2 The five roles

| Role | Main responsibility |
| --- | --- |
| Owner | Company control, security, all business permissions, budget approval, period reopening, evidence storage and ownership |
| Admin | Day-to-day workspace, team and master data; cannot transfer ownership |
| Manager | Counters, sales, members, inventory, purchasing, approvals and operating reports |
| Accountant | Ledger, customer invoicing, payables, expense payment, reconciliation, assets, budgets and close |
| Cashier | POS, members, coupons, receipts and read-only inventory |

Every person needs an individual account. Do not share accounts because critical actions identify the actual operator.

### 1.3 Owner go-live checklist

Prepare the workspace in this order:

1. In **Workspace**, set company name, country, regional format, time zone, tax display and book currency.
2. Create shops and warehouses in **Locations**, then create tills in **Counters**.
3. Create cash, bank, DuitNow or other methods in **Payment methods**.
4. Configure the necessary rate before foreign-currency purchasing.
5. Create individual users and roles in **Team & access**.
6. If expense evidence is used, the Owner configures a private GitHub repository and a fine-grained token with Contents read/write permission.
7. Create products, opening stock, suppliers, customers and required ledger accounts.
8. Run a test sale, refund, purchase, receipt and payment through the complete workflow.

The accounting currency cannot change after ledger entries exist. Country, locale or time-zone changes do not relabel historical money.

## 2. Daily operations

### 2.1 Open a shift

1. Open **Counters** and verify the device's location and counter.
2. Count the till and enter the physical opening amount.
3. Check the printer, scanner, payment display and network.
4. Run a small test or inspect the latest successful transaction.

### 2.2 POS sale

1. Open **Point of sale** and confirm the counter and selling location.
2. Search or scan products and adjust quantities.
3. When needed, select a member using name/phone fuzzy search, QR or NFC.
4. Apply an eligible coupon.
5. Review the server-calculated price, discount, tax and total.
6. Select a payment method and complete checkout.
7. Open the issued receipt to print, export or share its protected customer link.

A QR code, payer animation or local payment notification is not bank-settlement proof. After a network interruption, refresh **Receipts** to see whether the transaction exists before trying again.

### 2.3 Receipts and refunds

1. Find a sale in **Receipts** by receipt number, member or date.
2. Open it and inspect products, payments, tax, points and operator.
3. Choose refundable products and quantities and enter a genuine reason and method.
4. On submission, stock, batches, points and accounting reverse from the original sale snapshot together.
5. Repeated partial refunds cannot cumulatively exceed the original quantity or value.

Never rewrite an issued sale; create a refund to preserve reversal evidence. Confirm actual movement of funds with the payment provider or bank.

### 2.4 Handover and day end

1. Stop new activity on the counter.
2. Count actual cash and enter the closing amount.
3. Explain every difference factually.
4. Close the shift.
5. A Manager reviews unusual refunds, cash variances, open shifts and daily reports.

## 3. Sales and customers

### 3.1 Members

- Create members in **Members** and collect only information the business needs.
- A full QR/NFC selection token is shown once when issued; revoke and reissue a lost credential.
- QR/NFC selects a member or employee; it does not authenticate a user.
- An inactive member cannot use a selection credential.
- Never put complete identity, card or sensitive payment data in notes.

### 3.2 Coupons

1. Create a code in **Coupons**.
2. Set validity, minimum spend, discount, usage limits and member conditions.
3. Apply it before POS checkout and verify eligibility.
4. Disable an expired or retired offer instead of deleting redemption history.

### 3.3 Customer accounts and credit

1. In **Customer accounts**, create terms, credit limit and invoice defaults.
2. Credit is enforced when an invoice draft becomes `SENT`.
3. The credit check, state change and decision snapshot occur in one transaction so concurrent sends cannot bypass the limit.
4. Customer Statements exclude drafts and voids. They support internal reconciliation and do not prove external payment.

### 3.4 Quotations, delivery orders and invoices

1. Create a **Quotation** and review products, tax, money and validity.
2. Quotation states move forward only; only `ACCEPTED` can convert to an invoice draft.
3. A quotation can create at most one invoice draft.
4. Create a linked **Delivery order** where needed.
5. Planned, dispatched and delivered states are internal operations. They do not move stock, record payment or prove customer receipt.
6. In **Invoices**, review a draft before sending. Use allowed void or new-document workflows for corrections.

## 4. Inventory

### 4.1 Product master

In **Inventory**, create:

- a unique SKU, name, category and unit;
- selling price, cost and reorder level;
- batch tracking where needed;
- default cost centre or project;
- active status.

Cost affects margin and accounting and should be maintained only by authorised staff. Product dimension defaults affect future transactions only; historical snapshots do not change.

### 4.2 Opening stock and adjustments

- Establish real quantity through controlled opening balance, stocktake or explicit adjustment.
- Never edit a product to hide a stock difference.
- Record a reason, date and operator for adjustments.
- Before archiving a product, confirm it is no longer required for sales or purchasing. History keeps its product snapshot.

### 4.3 Batches and expiry

1. On receipt, enter the supplier lot and an expiry date after the receipt date for a batch-tracked product.
2. Use **Batch & expiry** to review upcoming expiry, expired inventory and freshness forecasts.
3. Sales use controlled batch allocation; do not bypass batch quantity manually.
4. A refund inherits the original sale's batch snapshot.

### 4.4 Stocktake

1. Create a Stocktake.
2. Reduce concurrent receiving, sales and transfers during the count.
3. Enter physical quantity and review differences.
4. Have an authorised user post it.
5. Keep the difference explanation and generated inventory/accounting evidence.

### 4.5 Disposal and loss

Use disposal/write-off for expired, damaged or unsaleable stock. Disposal is not deletion: it preserves the stock reduction, accounting impact, reason and operator.

### 4.6 Multi-location transfer

1. In **Stock transfers**, choose source, destination and products.
2. Verify source stock and batches, then dispatch.
3. Quantity remains in transit during transport.
4. The destination confirms the quantity actually received.
5. Use permitted state actions and reasons for a difference or cancellation.

Source and destination cannot match. Do not sell in-transit inventory at the destination early.

## 5. Purchasing and accounts payable

### 5.1 Suppliers

In **Purchasing & payables**, create the supplier code, name, contacts, tax number, country, currency, terms, lead time, minimum order and notes. Do not delete a historical supplier; archive it after open purchase orders are resolved.

**Supply Pulse** uses on-time receipt rate, average lateness and overdue orders to flag risk. It is a management indicator, not a supplier guarantee.

### 5.2 Smart replenishment

Recommendations combine:

- current stock;
- reorder level;
- recent 30-day sales;
- expected lead time;
- open purchase-order inbound quantity.

Use **Build from replenishment queue** while drafting a purchase order. A human still needs to consider seasonality, promotions, shelf life, storage capacity and supplier availability.

### 5.3 Purchase order

1. Create a purchase-order draft.
2. Choose supplier, receiving location and expected date.
3. Enter supplier reference, tax rate/mode, products, quantities and unit costs.
4. Check supplier currency, exchange rate and minimum order.
5. Save and obtain authorised approval. Except for the Owner small-business override, a maker cannot approve their own order.
6. A draft or approved order with no receipt can be cancelled with a reason.

### 5.4 Goods receipt

1. Receive only an `APPROVED` or `PARTIALLY_RECEIVED` order.
2. Enter only quantity physically received now, not the expected remainder.
3. Enter supplier invoice number, invoice date, receipt date and notes.
4. A batch-tracked product requires lot and expiry.
5. Submission updates inventory, weighted cost, supplier performance, payable, general ledger and audit in one database transaction.
6. If the supplier will not deliver the outstanding quantity, use **Close remainder** on a partially received order and record a permanent reason. This does not reverse received stock or bills.

### 5.5 AP aging

Open **Bills & payments** to review:

- Current;
- 1–30 days;
- 31–60 days;
- 61–90 days;
- over 90 days;
- amount due in the next seven days;
- total overdue exposure;
- supplier concentration.

Use **Export aging CSV** to give management or an external accountant the open-bill position as of the displayed date.

### 5.6 Supplier payment

1. Select an open bill.
2. Enter a payment amount. A partial payment is allowed but cannot exceed the balance.
3. Choose the cash or bank ledger account.
4. Enter a real, unique bank reference, payment date and note.
5. A foreign-currency bill uses the active payment-date rate and posts exchange gain or loss automatically.

The application payment record is not proof of bank settlement. Confirm it through bank reconciliation.

## 6. Employee expenses and evidence

1. An employee creates a claim draft with date, expense account, amount, tax and business explanation.
2. A draft accepts up to ten active files, uploaded sequentially.
3. Exact original bytes are retained. Maximum-quality Brotli is used only when smaller, then content is encrypted into the Owner-configured private GitHub repository.
4. The file limit is 4 MB to stay below Vercel Hobby request limits.
5. An eligible reviewer approves it. A non-Owner cannot review their own claim; an Owner override is audited.
6. An Accountant or Owner pays it using the real payment account, reference and date.

Common images, PDFs and text preview in the app. Browser-incompatible HEIC/HEIF remains downloadable. Preview and download independently enforce access, integrity and audit. Removing a draft attachment does not hard-delete its protected historical copy.

## 7. Accounting and financial control

### 7.1 Journals

1. In **Accounting**, choose the date and description.
2. Add debit and credit lines. Totals must balance.
3. Select an active cost centre or project when management reporting requires it.
4. Review the period, accounts and support before posting.
5. Correct a posted error with a reversal and new entry, never a silent rewrite.

Reports read `POSTED` journals only.

### 7.2 Bank reconciliation

1. Download a CSV from the bank and preserve genuine references.
2. Choose the bank account, statement range, opening and closing balances.
3. Import and validate rows and statement arithmetic.
4. Review every suggestion and confirm manually; no suggestion auto-confirms.
5. Complete and lock the working paper only at zero difference.

This is not a live bank feed and does not prove settlement. Completion freezes the cleared and uncleared snapshot reviewed at that time.

### 7.3 Month-end close

Close months in order:

1. Complete bank reconciliation.
2. Confirm journal integrity and balance.
3. Review receivables, payables, inventory exceptions and expenses.
4. Post due book depreciation.
5. Resolve blockers and material warnings.
6. Close the month and retain its snapshot.

A closed period blocks new accounting writes. Only the Owner can reopen in reverse order, and reopening does not remove prior close evidence.

### 7.4 Fixed assets

1. Create asset number, category, acquisition date, cost, residual value and useful life.
2. Choose a posted acquisition or explicitly identify a register-only migration.
3. Run book depreciation sequentially by month.
4. Enter date, proceeds and explanation on disposal.
5. Reconcile the register to generated ledger entries.

Book depreciation is not a tax capital-allowance schedule.

### 7.5 Budgets

- Budgets are calendar-year management plans for revenue and expense accounts.
- Accountant or Admin can edit the single draft.
- Manager can read.
- Only Owner approves.
- A newly approved revision supersedes and locks the previous approved version.
- Actuals come only from posted journal normal balances.
- Revenue above budget or expense below budget is positive performance.

A budget is not a journal, statutory return or guaranteed forecast.

### 7.6 Cost centres and projects

- Codes are permanent master identities. Archive an unused code instead of deleting history.
- Manual and automatic lines keep ObjectId, code and name snapshots.
- Exact rules can allocate POS locations, purchase locations or expense accounts.
- Archiving a dimension disables rules that reference it.
- Dimension P&L uses posted revenue/expense and isolates unassigned activity.

Dimension analysis does not change ledger balance, period locks or statutory financial statements.

## 8. Reports and electronic files

### 8.1 Financial and operating reports

Choose a period in **Reports** to view and export profit and loss, balance sheet, trial balance, cash flow, inventory, sales and other operating analysis. Record the covered period on CSV or PDF exports and reconcile summaries to their detail.

### 8.2 Country reports

The Country report desk prepares management working papers across selectable countries and partial layouts for MY, SG, AU and GB. It is not a certified tax return. A qualified local accountant or tax adviser must review formal use.

### 8.3 Electronic-invoice files

The system prepares, encrypts and retains UBL XML, accounting JSON and limited MyInvois files. It currently does not provide:

- tax-authority submission;
- a digital signature;
- official acceptance status;
- proof of completed statutory filing.

Never describe “file generated” as “submitted to government”.

## 9. Settings, security and maintenance

### 9.1 Workspace, locations and templates

- **Workspace** maintains company, regional, tax-display and contact settings for future transactions.
- **Locations** maintains shops, warehouses and hierarchy.
- **Counters** maintains tills and their managers.
- **Payment methods** maintains available payment types and display order.
- Receipt and invoice studios maintain document appearance; preview before live use.

### 9.2 Team security

1. Give each person an individual account and least-privilege role.
2. Issue a temporary password and force change at first sign-in.
3. Disable a leaver immediately; do not rename their account for a new employee.
4. Review Owner recovery, evidence token and ownership-transfer requests regularly.
5. Never send a password, database URI, API token or webhook secret in chat, screenshots or ordinary support tickets.

### 9.3 Audit and exceptions

Use **Reviews** for sales, inventory, payment and access exceptions. Record investigation, responsibility and resolution before closing. Audit evidence records the system actor and time but does not replace genuine management review.

### 9.4 Data retention

In **Maintenance**, preview the impact before an allowed cleanup of operational data. Back up and record approval first. Financial evidence, issued documents and required attachments are not hard-deleted by ordinary retention work.

## 10. Troubleshooting

### Slow page

Let the current action finish, then refresh once. Do not repeatedly submit payment, receipt or checkout. After recovery, check whether a receipt, bill or payment already exists.

### Session expired

Sign in again. If it repeats, an Admin should check whether the account was disabled, the password was reset or the browser blocks cookies.

### Access denied

Verify the user's role and duties. Never use a shared administrator account.

### Scanner or NFC does not respond

Check browser/device permission, scanner-session expiry, credential revocation and whether the current page is waiting for a scan.

### Evidence does not open

Try download. If that also fails, give the Owner the claim number, file name, time and on-screen error—never the GitHub token. HEIC/HEIF may be download-only.

### Database or deployment error

Record the occurrence time, page, document number and safe error text. Never send a database URI or environment variables to ordinary support.

## 11. Training checklist

Every new user should complete the relevant items using test data:

- sign in, change password and sign out;
- identify menus allowed by their role;
- open a shift, make a sale, find the receipt and close the shift;
- search for a member and explain why QR/NFC is not login;
- explain refund versus direct modification;
- review inventory and batches;
- for Managers: create, approve, partly receive and short-close a purchase order;
- for Accountants: review AP aging, payment, journal, bank reconciliation and close;
- upload, preview and download expense evidence;
- export one CSV and print one PDF;
- name five things the system does not prove: bank settlement, customer delivery acceptance, tax-authority acceptance, certified filing and tax capital allowances.

## 12. Information to provide when requesting support

- page or module;
- document number;
- local date and time;
- action performed;
- safe on-screen error text;
- whether it repeated after one refresh;
- browser and device type.

Never provide passwords, session cookies, database credentials, GitHub tokens, webhook secrets or complete sensitive payment details.
