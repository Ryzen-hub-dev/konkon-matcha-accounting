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
   - `AUTH_SECRET` — at least 32 random characters
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
- `settings` and `chartOfAccounts`
- `products` and `stockMovements`
- `members`, `sales`, `journalEntries` and `invoices`

No database exports or real customer records belong in Git.

## First live checks

- Owner can sign in and generate one Cashier test account.
- Cashier cannot open Accounting or change team access.
- A test POS sale reduces product stock and creates a posted journal.
- A member sale increases points and lifetime spend.
- A paid invoice creates a cash-basis bank/revenue journal, including GST payable when configured.
- `npm run build` passes in the deployment log.
