# Country reports, electronic invoices and a remote NFC phone

## Country reports

Open **Reports → Country report desk**, choose the period and reporting country, review the working figures, then download CSV or accounting JSON. The desk supports all 249 countries/regions already in the workspace catalogue. It uses the established matcha document style on desktop and mobile.

The export contains profit & loss, balance sheet, cash flow, trial balance, tax ledger evidence, reconciliation status and the selected country working paper. Changing the reporting country does **not** convert book currency, relabel historical balances, change the workspace country or alter dates. Zero- and three-decimal currencies retain their own precision. CSV cells are protected against spreadsheet formula injection.

The `2026-09-13-preparation-v1` working-paper adapters include:

- Singapore: core GST F5 figures and derived boxes 4/8; not the complete F5 return.
- Malaysia: separate sales-tax and service-tax preparation totals; no assumed VAT input credit.
- Australia: G1, 1A and 1B GST preparation; not a complete BAS.
- United Kingdom: VAT preparation figures, derived boxes 3/5, and an explicit special-scheme review warning; not an MTD submission.
- Other countries: generic accountant-classified working papers, explicitly marked as having no national tax-return adapter.

Blank figures mean **not reviewed**, never zero. Reviewed values are entered by the user and are not guessed from a single tax rate. Working entries live in the open report desk; export them before changing country/period, navigating away or refreshing. There is no saved tax-return workflow yet.

Financial statements reflect **posted journals**, not a promise of complete accrual accounting. The current customer-invoice workflow posts revenue upon payment; sent unpaid invoices require appropriate accountant-approved accrual entries for accrual reporting. Country statutory disclosures, fiscal calendars, consolidation, corporate income-tax adjustments, special schemes and filing-language translations are not generated automatically. CSV/JSON exports are management/accounting working papers, not certified returns.

## E-invoice files

Open an invoice or staff receipt, choose **E-invoice files**, complete the supplier/buyer legal details and tax treatment, confirm the review, then **Generate and save file**. Download an immutable snapshot from the history below.

Available formats:

- **General UBL 2.1 XML**: structured invoice interchange; no false Peppol customization/profile identifiers. Representative MYR, JPY, KWD and EUR documents are release-tested against the official OASIS UBL 2.1 XSD. This is not validation of every invoice against national business rules.
- **Accounting JSON**: explicitly versioned Kōn-Kōn structured invoice data, with original document ID, dates, parties, currency, lines and totals.
- **MyInvois 1.0 JSON preparation**: domestic Malaysian business-to-business MYR documents, BRN identity type, one classification and one tax type. Enter TINs, MSIC, activity, classification, state codes, phone numbers and SST registrations. `NA` must be entered explicitly when appropriate. The adapter preserves the original reference and uses current UTC generation time as MyInvois issue time. It does not verify TINs or external MSIC/classification code registries, and does not sign or submit. Verify version availability before use; v1.0 has different signature behavior from v1.1.

Generation is restricted to `invoices.write`, with source-specific read access for downloads. Only sent/paid invoices and completed, unrefunded receipts are supported. Drafts, voids and refunded receipts are rejected. Credit/debit/refund notes, consolidated invoices, foreign-currency MyInvois, consumer identity types, mixed-rate/classification documents, PINT-SG/InvoiceNow transport, national signatures and tax-authority submission are **not implemented** by this release.

The original transaction supplies all amounts. Integer minor-unit allocation reconciles discounts and inclusive tax into net lines. Supplier country must match the historical snapshot. Missing/unsafe source data and inconsistent totals are blocked. Generating a file does not post another sale or journal.

Every saved file has status `GENERATED_NOT_SUBMITTED` and validation `LOCAL_STRUCTURE_AND_TOTALS_ONLY`. There is no fabricated tax authority UUID, QR acceptance code or successful-submission state. A historical generated invoice remains in history after a later refund; it is **not** a credit note and must not be reused as proof that the refund was reported.

Files are AES-256-GCM encrypted with per-artifact authenticated context under the existing application encryption key, and SHA-256 is checked at download. Only metadata is listed. Keep `AUTH_SECRET` stable and backed up securely; replacing it without migrating encrypted data makes existing encrypted cards, scan events and documents unreadable. Rotation requires an explicit migration plan. Audits record generation/download without tax IDs or addresses.

Generation + source locking + audit run in a MongoDB transaction. A unique operator/request key makes retries idempotent and rejects changed details under a reused key. Each source is limited to 50 snapshots; each output is limited to 1 MB. No external provider credentials are requested or stored in this flow.

## Use another phone for NFC binding

1. On the counter, open **Members → member card → Connect another phone**.
2. Scan the private QR with a compatible Android phone and open its HTTPS link.
3. The phone automatically starts NFC listening when the pass opens. On the first browser permission prompt, tap **Start NFC (if needed)** once, then hold one readable card against it.
4. The counter displays the protected fingerprint suffix and target member. Click **Confirm NFC binding** or discard the read.
5. Use **Disconnect** to revoke the link immediately. A counter refresh resumes an existing reader for that member; the original private URL is only shown when issued.

The new `MEMBER_BIND` purpose is locked to one member and the issuing operator. POS, Inventory, Receipts and Members lookup routing cannot adopt or retarget it. It needs `members.write`, an open workspace, current operator access and an active target. Normal pass expiry (up to 24 hours), revocation, session-version and scanner-generation invalidation still apply. The phone sends only protected NFC fingerprints; it cannot query member data. Fingerprints are encrypted while queued, and the persistent binding is keyed/hashed. Binding does not write or erase the physical card. Existing same-phone binding and issued-card writing remain available.

Web NFC requires compatible Android Chrome, HTTPS, NFC permission, foreground page and a readable NDEF tag. Some hotel/transit/payment cards are inaccessible. iPhone browser NFC and arbitrary low-level card access are not supplied by Web NFC. Static NFC identities can be copied; this is membership lookup, **not** payment authorization or a clone-resistant authentication factor. Real card/device compatibility requires physical acceptance testing; automated QA simulates the browser NFC device boundary.

## Vercel and verification

Uses short Node.js requests, cached MongoDB connections, bounded polling (up to 3 seconds per poll), no WebSocket service, no background daemon and no runtime filesystem persistence. Idle/hidden counter pages pause polling; awaiting confirmation also pauses it. Each active reader still consumes requests/compute, so free-plan quotas are not unlimited. Revoke unused readers. No new paid service was added.

Commands:

```text
npm test
npm run build
node scripts/receipt-membership-smoke.cjs <directory-containing-playwright>
node --import tsx scripts/validate-e-invoice-xsd.ts <python-with-lxml> <official-UBL-Invoice-2.1.xsd>
```

The smoke harness creates a random isolated database and prefix, checks emptiness before use and removes only its temporary collections. It never reuses production business data. Do not commit private connection strings or test exports.

## Official references

- [OASIS UBL 2.1](https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.html)
- [LHDN invoice v1.0](https://sdk.myinvois.hasil.gov.my/documents/invoice-v1-0/) and [official sample payloads](https://sdk.myinvois.hasil.gov.my/sample/)
- [Peppol current post-award specifications](https://peppol.org/documentation/technical-documentation/post-award-documentation/)
- [IRAS GST return guidance](https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/filing-gst/completing-gst-returns)
- [MySST forms](https://mysst.customs.gov.my/sst-forms/)
- [ATO BAS guidance](https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas)
- [HMRC VAT Notice 700/12](https://www.gov.uk/guidance/how-to-fill-in-and-submit-your-vat-return-vat-notice-70012)
- [Chrome Web NFC capabilities](https://developer.chrome.com/docs/capabilities/nfc)
