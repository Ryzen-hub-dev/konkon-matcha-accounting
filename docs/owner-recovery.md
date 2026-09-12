# Replace a lost Owner account

This is an explicitly authorized maintenance operation, not public registration or a password-reset endpoint. Deploy the recovery page/API and test them before removing any production account.

The operator verifies the exact sole Owner ID, retains all other accounts and issues a 256-bit random recovery capability. The old login is removed; a profile-only record is retained in `archivedUsers` for historical reference, **without the old password hash**. Only that Owner's scanner and payment-display passes are revoked. Financial records, member details, templates, company settings, system mode and the first-run setup lock are unchanged. Pending ownership transfers must be resolved separately before proceeding; maintenance refuses to race them.

## Operator procedure

Use a trusted local shell with authorized MongoDB configuration. Never commit environment files, database credentials or the generated recovery link. `MONGODB_URI`, `MONGODB_DB_NAME`, `MONGODB_COLLECTION_PREFIX` and `NEXT_PUBLIC_APP_URL` identify the existing workspace. The last value must be the HTTPS application origin.

1. Run `node --import tsx scripts/reset-owner.ts` for a **read-only** Owner identity check.
2. Verify the displayed database, business, exact Owner ID and remaining users. At least one other user must remain so ordinary `/setup` registration stays closed.
3. Only with explicit authorization, run `node --import tsx scripts/reset-owner.ts --confirm-remove VERIFIED_OWNER_ID`. The script checks that `/recover-owner` is deployed before attempting its atomic transaction.
4. Give the resulting private link directly to the authorized user. Do not put it in a Git commit, ticket, public screenshot or analytics event. The link expires after 24 hours and works only once.

An optional `--config-file` accepts a private JSON object with `uri`, `dbName`, `prefix`, `siteUrl`; keep it ignored/outside version control and remove the temporary copy after use. The command deliberately displays the generated link once so it can be delivered securely.

## User procedure

Open the complete private `/recover-owner#token=…` link and enter the replacement Owner's name, username, email and password. Existing usernames/emails cannot be taken over. Passwords require at least 12 characters including uppercase, lowercase and a number, with at most 72 UTF-8 bytes because authentication uses bcrypt.

The capability is read from the URL fragment, immediately removed from the address bar and kept only in memory. Reopen the original private link after refreshing an unfinished form. No capability is put in a query string, cookie, browser storage, audit log or database plaintext. The database stores its SHA-256 digest and enforces expiration during every claim, so no scheduled task is required on Vercel.

Registration creates exactly one new Owner and consumes the capability in the same MongoDB transaction. Simultaneous submissions cannot create two Owners; rejected duplicate identities leave the capability available for correction. Existing stale login cookies do not block this page; successful registration replaces the browser session. If the response is lost after creation, sign in using the new account details instead of resetting the workspace again.

The original Owner password is not recoverable from the profile archive. Historical records continue to reference their original author IDs. Reissuing an expired/lost link requires a separately authorized operator procedure; there is intentionally no public issuance or account-deletion endpoint.

## Verification

Run `npm test`, `npm run build`, then the development-only isolated acceptance harness: `node scripts/owner-recovery-smoke.cjs PATH_TO_PLAYWRIGHT_PACKAGE`. The harness needs the optional `mongodb-memory-server` test dependency under `.artifacts/regional-mongo`; it does not use production credentials. It checks reset preservation, invalid/expired links, validation, identity conflicts, concurrent claims and browser registration.
