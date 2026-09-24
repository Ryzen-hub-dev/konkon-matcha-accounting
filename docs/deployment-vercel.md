# Vercel deployment guide

## Before deploying

Rotate every credential that has appeared in a chat, screenshot, terminal log or committed file. At minimum rotate the MongoDB database password, Discord client secret and any encryption key that was exposed. This accounting application does not require Discord credentials, so they are intentionally absent from `.env.example`.

In MongoDB Atlas:

- Create a dedicated database user for this application.
- Grant only read/write access to the selected database.
- Prefer a `mongodb+srv://` connection string.
- Configure Network Access for Vercel. Hobby deployments do not provide fixed outbound IPs; use the Atlas/Vercel integration where available or an appropriately protected Atlas network rule.
- Use a new database name such as `konkon_matcha_accounting` instead of reusing an unrelated application's database.

## Vercel project

1. Import `Ryzen-hub-dev/konkon-matcha-accounting` in Vercel.
2. Keep the framework preset as Next.js.
3. Add these Production, Preview and Development variables:
   - `MONGODB_URI`
   - `MONGODB_DB_NAME`
   - `MONGODB_COLLECTION_PREFIX` — for example `konkon_`
   - `AUTH_SECRET` — at least 32 random characters
   - `IDENTITY_LOOKUP_SECRET` — a different stable 32+ character HMAC secret; set it before storing member IDs
   - `PAYMENT_WEBHOOK_SECRET` — a third, different 32+ character HMAC secret used only as a fallback for signed payment callbacks
   - `PAYMENT_WEBHOOK_SECRET_<PROVIDER>` — preferred provider-specific callback secret, for example `PAYMENT_WEBHOOK_SECRET_PAYNOW`, `PAYMENT_WEBHOOK_SECRET_DUITNOW`, `PAYMENT_WEBHOOK_SECRET_TNG` or `PAYMENT_WEBHOOK_SECRET_GRABPAY`
   - `NEXT_PUBLIC_APP_URL` — the final HTTPS origin
4. Deploy. `vercel.json` enables Fluid Compute and selects Singapore (`sin1`).
5. Visit `/setup` immediately and create the Owner. Once any user exists, the setup API permanently refuses another Owner bootstrap.
6. Sign in, open Workspace, set the GST rate and verify the product catalogue before the first live sale.

## Free-plan design choices

The application avoids background workers, WebSockets, local file uploads and in-memory session state. It reuses a small MongoDB connection pool, caps list queries, keeps route handlers short and uses an external database as the source of truth. This makes it technically suitable for Vercel's serverless limits.

Vercel Hobby is officially for personal, non-commercial projects. Use it for development and evaluation only; deploy the live business workspace on Pro. Current limit details should always be checked in Vercel's official Hobby and Functions documentation before launch.

## MongoDB collections

Indexes are created automatically on first connection. The application stores:

- `users`, `systemLocks` and `auditLogs`
- `settings`, `settingsHistory`, `locations`, `exchangeRates` and `chartOfAccounts`
- `products` and `stockMovements`
- `suppliers`, `purchaseOrders`, `goodsReceipts`, `accountsPayableBills` and `supplierPayments`
- `payrollProfiles`, `payrollRuns` and `consolidationRuns`
- encrypted `notificationConnections`, `shippingConnections` and `taxConnections`
- bounded `shippingWaybills` plus TTL-cleaned `shippingWebhookEvents`
- `members`, `sales`, `journalEntries` and `invoices`
- `coupons` and `couponRedemptions`
- `scannerSessions` and short-lived `scannerEvents`
- short-lived `paymentIntents`, provider `paymentConfirmations` and replay-protected `paymentWebhookEvents`
- `systemControls`, `ownershipTransfers` and short-lived security throttle collections

No database exports or real customer records belong in Git.

## First live checks

- Owner can sign in and generate one Cashier test account.
- Cashier cannot open Accounting or change team access.
- A test POS sale reduces product stock and creates a posted journal.
- A member sale increases points and lifetime spend.
- A product barcode and printable member card both resolve through the POS scan dock.
- A coupon is recalculated by the sale API and its use counter advances once.
- A phone scanner pass accepts a code, appears at the selected POS and fails immediately after revocation.
- An unverified provider wallet/transfer cannot post a sale or reduce stock; a signed provider confirmation must match the exact method, provider, currency and minor-unit amount, and it can be consumed only once.
- A foreign-currency test sale uses the active locked rate, records both base and tender amounts, and reprints the same historical rate.
- Refreshing or changing pages restores the active POS order from the current cashier's browser without persisting payment references or provider confirmation codes.
- Read-only mode blocks writes; closed mode blocks business APIs; reopening restores access.
- A paid invoice creates a cash-basis bank/revenue journal, including GST payable when configured.
- A payroll run freezes reviewed employee terms, requires the correct approver and posts balanced accrual/payment journals once.
- A consolidation run rejects unbalanced imported trial balances/eliminations and produces equal reporting-currency debit/credit totals.
- Telegram/Feishu/Discord connections send a visible test message; system-control broadcasts report per-provider success without leaking secrets.
- A Ninja Van sandbox booking returns a tracking number, its signed Pending Pickup Webhook is accepted once, and the PDF waybill is cached after first generation.
- A MyInvois sandbox ERP connection submits only a reviewed `MYINVOIS_JSON` artifact and status refresh stores the authority response; do not begin production before sandbox and professional acceptance.
- A supplier can be created, a purchase order approved, partially received and completed; each retry returns the original receipt without increasing stock twice.
- A receipt whose supplier invoice total or tax differs from the purchase-order-derived value creates an approval request without stock, AP or journal changes. A different authorised user can approve it, and only an exact retry consumes that approval and posts once.
- An original goods-receipt bill can add a landed-cost supplier invoice by value or quantity. Retrying the same request does not duplicate product cost, AP or journals; duplicate supplier invoices are rejected, and a closed accounting period blocks posting.
- An unpaid supplier bill can open its source receipt and post a partial purchase return; the supplier credit, exact tax/value slice, original location/batch stock and journal update once, while a paid bill is rejected.
- Each goods receipt creates one supplier bill and balanced inventory/input-tax/AP journal, and each bill payment creates one balanced cash/bank/AP journal with any realised FX difference.
- `npm run build` passes in the deployment log.
### Evidence storage ceiling

The application enforces a 10 GiB logical limit for its encrypted expense and online-order attachments. It warns at 8 GiB and stops new uploads at 9.5 GiB so 512 MiB remains as a concurrency reserve. The Owner can inspect current managed usage under Settings → Private evidence repository. This limit does not measure unrelated files or Git history, and it does not delete statutory or financial evidence. Use a dedicated private repository; migrate to lifecycle-capable object storage before the warning threshold if continuous attachment growth is required.
