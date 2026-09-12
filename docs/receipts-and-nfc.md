# Digital receipts and QR / NFC membership

## Receipt workflow

1. Open **Receipts** and search by receipt number, member, cashier or payment reference. A keyboard-wedge scanner or linked phone can read the receipt QR in the scan box. POS also recognises receipt QRs and opens the corresponding receipt.
2. Open the historical receipt to inspect its original business/template snapshot and refund history. Authorized Owner/Admin/Manager operators can refund remaining item quantities with a reason. Existing transaction logic returns stock and reverses ledger, tax and points; a QR alone cannot post a refund or transfer money.
3. New receipts and reprints of existing receipts include a signed customer QR. Customers need no account to view that specific receipt, print/save a PDF, download CSV or export accounting JSON. Current refund totals and refunded item quantities are included in exported data.
4. Share customer links only with the customer. Anyone possessing a link can read that receipt's allowed fields. The public API excludes member/cashier identity, costs, internal notes and private payment references. Receipt titles, custom branding and customer-facing template text remain visible.

The token is carried in a URL fragment and removed from the address bar after opening; it is sent to the receipt API in a POST body, not in a request URL. Refreshing the cleaned URL requires reopening the original QR. Do not add third-party scripts or analytics to these pages. Printing waits for the QR image to finish loading.

Receipt access is HMAC-SHA256 signed using a domain-separated `AUTH_SECRET`. New sales also get a random per-receipt access version. Legacy sales use their ID with a signed legacy version, without rewriting financial records. Rotating `AUTH_SECRET` invalidates previously printed receipt links. An operator can revoke one link by setting `receiptAccessRevoked` on the exact sale, or rotate its `receiptAccessVersion`; no bulk receipt rewrite is necessary. No customer-facing revocation UI is shipped in this change.

## E-invoice boundary

The accounting JSON contains a versioned `eInvoice` preparation object, source receipt number, country code and `NOT_SUBMITTED` status. It is **not** a tax authority submission, a certified e-invoice or a jurisdiction-specific schema. No government credentials, network connector or automatic tax filing is included. A future country integration must collect and validate the legally required buyer/seller information with appropriate consent, implement authority schemas and protect that data behind authenticated access. Do not put national IDs into a public receipt QR.

## Quantity entry

Click the cart's quantity, enter a whole number, then press Enter or leave the field. Invalid/zero/fractional quantities or quantities above stock/the 999-unit line limit are rejected. Use Remove to remove a line. The server independently checks quantity, current stock and price at checkout.

## Member card workflow

1. Open **Members → member card → QR & NFC cards**.
2. Issue a card with its own label, membership title and colour. The title is visual branding, not an automatic discount or rewards rule. One member can hold up to 20 active/suspended cards.
3. Select **QR / NFC / print** to print a QR credential or write an NFC tag. For a separate phone, open **Write this card using another phone** and scan the private writer link.
4. Use **Link a phone** on POS or Members, open the scanner pass on that phone, then press **Start NFC reader** and tap the issued NDEF card. The desktop receives the credential and performs an authenticated active-card/member lookup. POS selects the member; Members shows the matching profile.
5. **Suspend** is reversible; **Void** is permanent. **Delete** retires the credential while preserving card, membership and accounting audit history. A replacement card receives a new random credential. Existing legacy Code 39 member cards are managed separately; retiring an NFC card does not revoke a different legacy card.

NFC requires HTTPS (localhost is allowed for development), a compatible NFC-enabled Android phone, Chrome and a writable NDEF tag. Safari/iPhone and many desktop browsers do not expose Web NFC; use QR or a keyboard-wedge reader there. Generic bank/transport cards, secure smart-card protocols and arbitrary UID-only cards are not supported. NFC permissions require a user gesture. Writing replaces the tag's current NDEF content, so use a dedicated membership tag. The writer does not lock a tag read-only.

References: [Chrome Web NFC guide](https://developer.chrome.com/docs/capabilities/nfc), [MDN Web NFC](https://developer.mozilla.org/en-US/docs/Web/API/Web_NFC_API).

## Security and operations

- Tags store only a random 256-bit `KKMC1` credential, never a name, phone, identity number, points balance or payment data. A static NDEF credential can be copied: this is member identification, not anti-cloning hardware or payment authorization. Verify additional customer identity before sensitive redemptions.
- Card lookup is authenticated. Credential reveal requires member-write permission and creates an audit event. Database records store a SHA-256 lookup hash and AES-256-GCM ciphertext, bound to the card ID with authenticated additional data. Void/delete removes recoverable ciphertext and lookup rejects the retired card immediately.
- Card encryption derives a separate-purpose key from `AUTH_SECRET`. Back up that secret securely alongside database recovery procedures. Changing it makes existing encrypted card credentials unreadable for reprint; issued tags still match their stored hashes until retired. Reissue cards or implement a controlled key migration before a planned rotation.
- Member and receipt tokens sent through the phone scanner queue are encrypted at rest and expire with the pass. A pass is valid for at most 24 hours, can be revoked, and is rejected after system-mode generation changes or the issuing operator's session-version/permissions become invalid. A revoked pass cannot send another code.
- A phone pass only sends codes and sees connection/acceptance state; it cannot read profiles, receipts, catalogue or financial reports. NFC identifies a member only on the authenticated receiving screen.
- Public receipt and writer pages have no-index/no-referrer/no-store headers. No new cloud service, WebSocket, persistent process or paid Vercel add-on is required. Existing scanner polling still consumes request/database usage and must be monitored against hosting limits.

## Verification

`tests/receipt-membership.test.ts` exercises token tampering, link revocation, public-field filtering, card encryption/AAD, quantity boundaries, CSV formula escaping and scanner-purpose permissions.

`scripts/receipt-membership-smoke.cjs <Playwright node_modules directory>` runs API/browser acceptance against a fresh loopback-only MongoDB replica set and the production build. It expects a local `mongodb-memory-server` runtime in `.artifacts/regional-mongo/node_modules` and Microsoft Edge. Alternatively supply a test-authorized cluster URI through `COMMERCE_TEST_MONGODB_URI`; it always generates a random `konkon_qa_commerce_*` database name, rejects any pre-existing database and drops only its own temporary database on cleanup. It generates disposable test users and never selects production collections. Keep connection credentials out of source control and logs. NFC browser events are simulated: physical tag, reader, camera and thermal-printer verification remain hardware acceptance steps.
