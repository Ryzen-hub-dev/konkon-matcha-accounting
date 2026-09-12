import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { receiptAccessToken, validReceiptAccess, publicReceipt } from "../lib/receipt-access";
import { memberBindingScanToken, memberScanToken, receiptScanToken, cartQuantity } from "../lib/scan-codes";
import { encryptMemberToken, decryptMemberToken, memberBindingHash, newMemberToken, memberTokenHash, cardUpdateSchema } from "../lib/member-cards";
import { receiptCsv, csvCell } from "../lib/receipt-export";
import { scannerPurposeFilter, scannerPermission } from "../lib/scanner-routing";

process.env.AUTH_SECRET = "test-only-receipt-membership-secret-with-40-characters";
test("receipt QR authorization resists tampering, cross-sale reuse and revocation", () => {
  const sale = { _id: new ObjectId(), receiptAccessVersion: "one" };
  const token = receiptAccessToken(sale);
  assert.ok(validReceiptAccess(sale, token));
  assert.ok(validReceiptAccess(sale, token.toUpperCase()));
  assert.equal(validReceiptAccess({ ...sale, _id: new ObjectId() }, token), false);
  assert.equal(validReceiptAccess({ ...sale, receiptAccessVersion: "two" }, token), false);
  assert.equal(validReceiptAccess({ ...sale, receiptAccessRevoked: true }, token), false);
  assert.equal(validReceiptAccess(sale, token.slice(0, -1)), false);
  assert.equal(receiptScanToken(`https://shop.example/r#receipt=${token}`), token.toLowerCase());
});
test("public receipts exclude internal finances and personal identifiers, including nested lines", () => {
  const sale = { _id: new ObjectId(), receiptNo: "TEST", total: 12, totalCost: 3, memberName: "PRIVATE", memberId: new ObjectId(), cashierName: "PRIVATE", paymentReference: "SECRET", saleNote: "PRIVATE", passwordHash: "SECRET", businessSnapshot: { businessName: "Store", currency: "MYR", privateKey: "SECRET" }, items: [{ name: "Tea", price: 12, cost: 3, quantity: 1, lineTotal: 12, lineCost: 3, privateKey: "SECRET" }] };
  const result = publicReceipt(sale);
  assert.equal(result.total, 12);
  assert.equal(result.eInvoice.status, "NOT_SUBMITTED");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|totalCost|lineCost|memberId|cashierName/);
});
test("member credentials are random, encrypted with card-bound authenticated encryption and normalized for scanners", () => {
  const token = newMemberToken(); const id = new ObjectId().toHexString();
  assert.notEqual(newMemberToken(), token);
  const encrypted = encryptMemberToken(token, id);
  assert.ok(!encrypted.includes(token));
  assert.equal(decryptMemberToken(encrypted, id), token);
  assert.throws(() => decryptMemberToken(encrypted, new ObjectId().toHexString()));
  const fields = encrypted.split('.'); fields[1] = Buffer.alloc(16).toString('base64url');
  assert.throws(() => decryptMemberToken(fields.join('.'), id));
  assert.equal(memberScanToken(`https://shop.example/card-write#card=${token.toLowerCase()}`), token);
  assert.equal(memberTokenHash(token), memberTokenHash(token.toLowerCase()));
  assert.equal(memberScanToken("arbitrary-nfc-serial-123"), "");
  assert.equal(cardUpdateSchema.safeParse({ id, status: "DELETED" }).success, false);
});
test("existing NFC bindings use a purpose-separated keyed fingerprint and canonical scanner code", () => {
  const fingerprint = "ab".repeat(32);
  const code = `KKNT1-S-${fingerprint}`;
  const parsed = memberBindingScanToken(`  ${code.toLowerCase()}  `);
  assert.deepEqual(parsed, { source: "NFC_SERIAL", fingerprint });
  assert.equal(memberBindingHash("NFC_SERIAL", fingerprint), memberBindingHash("NFC_SERIAL", fingerprint.toUpperCase()));
  assert.notEqual(memberBindingHash("NFC_SERIAL", fingerprint), memberBindingHash("NDEF_DIGEST", fingerprint));
  assert.equal(memberBindingScanToken(`KKNT1-N-${fingerprint}`)?.source, "NDEF_DIGEST");
  assert.equal(memberBindingScanToken(`KKNT1-S-${"cd".repeat(31)}`), null);
});
test("quantity edits accept bounded whole units and reject blanks, decimals, negatives and stock excess", () => {
  assert.equal(cartQuantity("12", 15), 12);
  for (const value of ["", " ", "1.5", "1e2", "-1", "0", "16", "NaN"]) assert.equal(cartQuantity(value, 15), null);
  assert.equal(cartQuantity("1000", 2000), null);
});
test("receipt exports retain financial totals and escape spreadsheet formulas", () => {
  assert.equal(csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  const csv = receiptCsv({ receiptNo: "TEST", createdAt: "2026-09-13", items: [{ name: "+formula", price: 10, quantity: 2, lineTotal: 20 }], subtotal: 20, discount: 0, tax: 0, total: 20, refundedAmount: 10, businessSnapshot: { currency: "MYR" } });
  assert.ok(csv.includes('"Net retained","10"'));
  assert.ok(csv.includes('"\'+formula"'));
});
test("phone event destinations isolate receipt and member reads from sales and inventory writes", () => {
  assert.deepEqual(scannerPurposeFilter("RECEIPTS"), { purpose: "RECEIPTS" });
  assert.deepEqual(scannerPurposeFilter("MEMBERS"), { purpose: "MEMBERS" });
  assert.equal(scannerPermission("RECEIPTS"), "receipts.read");
  assert.equal(scannerPermission("INVENTORY"), "inventory.write");
});
