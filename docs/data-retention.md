# Deletion, storage and bounded maintenance

## Delete is different from disable

Team **Disable** is reversible. **Delete** is not: the account disappears from the directory, password/contact fields are erased, its existing sessions fail authorization, and its phone scanner/customer-display passes expire. The username and email can be reused by a new account. Owner deletion remains prohibited by the Team endpoint; use the separate guarded ownership/recovery workflow.

Member deletion erases the profile name, phone, email, identity lookup hash/last four digits/type and printable card credential. Issued QR/NFC tokens are revoked and erased. Registration may reuse the phone/identity details, but creates a new member ID and does not inherit the old points or spend. Card creation and deletion share a transactional member write to prevent a concurrently issued credential surviving deletion.

Minimal archived records retain stable IDs, member numbers and accounting aggregates for historical references. Existing receipts, invoices, refunds and mutation audits remain unchanged; their original names and financial snapshots are not a disposable address book. This is not a claim of complete legal erasure from all historical records or backups.

Existing physical-card bindings remain as non-reversible keyed fingerprints for the restricted **orphaned NFC registration** workflow. They cannot identify an active member after deletion. Clear the orphan registration before rebinding the physical card. Deleted/cleared card rows disappear from the normal card list immediately and become eligible for physical deletion after 90 days. An archived member's uncleared bound card is not silently erased.

## What expires

- Acknowledged scan events: encrypted/plain scan payload erased on ACK; remaining delivery metadata expires no later than 60 seconds after ACK.
- Scanner passes, unread scan events and display passes: their existing expiry, normally at most 24 hours. Revocation/owner session checks enforce access even before physical cleanup.
- Authentication throttles, protected-identity lookup throttles and local payment notification queues: their existing `expiresAt`/`expireAt` dates. Payment webhook delivery-deduplication records retain the existing 30-day policy; durable payment confirmations are separate and retained.
- Only this explicit audit allow-list expires after 90 days: `auth.login`, `member.identity_lookup`, `member_card.reveal`, `einvoice.download`, `scanner.issue`, `scanner.route`, `scanner.revoke`, `scanner.binding_start`, `scanner.binding_finish`, `payment-display.issue`, `payment-display.revoke`.
- Deleted/cleared card metadata: 90 days after `deletedAt`, and only when status is `DELETED`.

Ledger journals, sales, refunds, invoices, payment confirmations, stock movements, coupon redemption evidence, settings history, ownership events and business/account/card mutation audit logs have **no automatic purge added by this release**. Repeated unchanged settings saves and scanner routing do not create new writes/audit events.

MongoDB TTL cleanup is asynchronous, typically sweeping in about 60-second cycles and potentially lagging under load; expiry is not an exact deletion timestamp. The application must still enforce expiry itself. See [MongoDB TTL behavior](https://www.mongodb.com/docs/manual/core/index-ttl/).

## Daily job and manual controls

`vercel.json` calls `/api/maintenance` once daily at 19:00 UTC (approximately 03:00 Singapore time). Hobby supports daily jobs with hour-level precision; execution consumes the normal function allowance. See [Vercel scheduling limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Configure `CRON_SECRET` as a separate random value with at least 32 characters, Sensitive and Production-scoped. Vercel sends it as a Bearer token. No default token is accepted. See [Vercel cron protection](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

- Authenticated Owner `GET /api/maintenance` always previews without applying changes.
- Authenticated Owner, same-origin `POST /api/maintenance` applies one bounded batch.
- Cron Bearer `GET /api/maintenance?dryRun=1` previews; without that query it applies.
- Other roles and unauthenticated callers cannot run or inspect maintenance. Public URLs alone grant no maintenance access.

Each run selects at most 100 expired records per listed temporary collection, 25 legacy archived profiles per profile collection, 100 legacy operational logs lacking expiry, and 25 uncompressed legacy electronic invoices. It checks a 20-second work budget and returns `budgetReached` if a later batch must wait. Conditional updates/deletes make retries safe. Large backlogs drain gradually; this is not a promise to clear an entire database in one invocation. Native TTL handles normal ongoing expiry.

The response contains counts and document bytes saved, not personal data or document content. `dryRun` reports bounded candidates, not total database usage. No maintenance-run log is written to MongoDB; use Vercel execution logs. A failed job can be rerun by the Owner after resolving the cause. Inspect `invalidDocuments` and restore a verified backup for corrupt/unreadable artifacts; those artifacts are left untouched.

## Compression and protection

Electronic invoice files use native gzip only when its base64 representation is smaller than the original UTF-8 content, then the existing document-bound AES-256-GCM encryption. Downloads authenticate the encryption, bound decompression to 1 MB and verify the exact original SHA-256 digest. Legacy uncompressed encrypted documents remain readable and are migrated gradually after a verified round-trip. Generation idempotency, immutable source history and public/private access rules are unchanged. This does not make an e-invoice tax-authority submitted or certified.

Compression saves repetitive document payloads; it is not encryption, deduplication of legitimate transactions or a substitute for backups. Atlas Free counts logical uncompressed BSON plus indexes, so database-engine disk compression alone does not remove the quota. No measured production-space reduction should be claimed without actual before/after evidence. See [Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/).

Do not rotate `AUTH_SECRET` or `IDENTITY_LOOKUP_SECRET` casually: existing encrypted documents/card data and keyed identity lookups depend on them. Secure backups, a key migration plan, access controls and restore testing remain necessary. Automatically erased contacts/credentials cannot be recovered in-app; retained financial documents are not deleted by maintenance.
