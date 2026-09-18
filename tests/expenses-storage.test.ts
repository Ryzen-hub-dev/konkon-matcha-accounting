import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expenseAmounts, MAX_EXPENSE_ATTACHMENTS } from "../lib/expenses";
import { MAX_ATTACHMENT_BYTES, packLosslessPayload, unpackLosslessPayload } from "../lib/lossless-storage";
import { encryptMemberToken } from "../lib/member-cards";
import { packDocument, unpackDocument } from "../lib/document-storage";
import { newStaffSelectionToken, staffSelectionTokenHash } from "../lib/staff-credentials";
import { staffScanToken } from "../lib/scan-codes";
import { searchUsers } from "../lib/user-search";
import { hasPermission } from "../lib/rbac";
import { isWritePermission } from "../lib/system-control";
import { attachmentContentDisposition, attachmentPreviewKind, safeAttachmentName } from "../lib/attachment-files";

process.env.AUTH_SECRET ||= "test-only-auth-secret-that-is-longer-than-thirty-two-characters";

test("evidence compression preserves exact bytes and avoids expanding incompressible input", () => {
  const repetitive = Buffer.from("lossless-receipt-line\n".repeat(4_000));
  const packed = packLosslessPayload(repetitive, "expense-attachment:test-a");
  assert.equal(packed.encoding, "br-max-v1");
  assert.ok(packed.storedSize < repetitive.length);
  assert.deepEqual(unpackLosslessPayload(packed.bytes, "expense-attachment:test-a"), repetitive);

  const random = randomBytes(8_192);
  const randomPacked = packLosslessPayload(random, "expense-attachment:test-b");
  assert.equal(randomPacked.encoding, "identity-v1");
  assert.deepEqual(unpackLosslessPayload(randomPacked.bytes, "expense-attachment:test-b"), random);
  assert.throws(() => unpackLosslessPayload(randomPacked.bytes, "expense-attachment:wrong"));
  assert.equal(MAX_ATTACHMENT_BYTES, 4 * 1024 * 1024);
  assert.throws(() => packLosslessPayload(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), "expense-attachment:too-large"), /4 MB/);
});

test("protected evidence selects safe previews and download headers", () => {
  assert.equal(attachmentPreviewKind("image/jpeg"), "IMAGE");
  assert.equal(attachmentPreviewKind("application/pdf"), "PDF");
  assert.equal(attachmentPreviewKind("text/plain"), "TEXT");
  assert.equal(attachmentPreviewKind("application/octet-stream"), "DOWNLOAD");
  assert.equal(safeAttachmentName(" ../receipt\r\n.jpg "), "..-receipt.jpg");
  assert.match(attachmentContentDisposition("收据 1.jpg", false), /^inline;/);
  assert.match(attachmentContentDisposition("收据 1.jpg", true), /^attachment;/);
  assert.match(attachmentContentDisposition("收据 1.jpg", true), /filename\*=UTF-8''/);
});

test("text documents use Brotli while legacy gzip documents remain readable", () => {
  const content = "<Invoice>matcha evidence</Invoice>".repeat(300);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const packed = packDocument(content, "document:test");
  assert.equal(packed.contentEncoding, "br-base64-v2");
  assert.equal(unpackDocument({ ...packed, sha256 }, "document:test"), content);

  const legacy = gzipSync(Buffer.from(content), { level: 6 }).toString("base64url");
  assert.equal(unpackDocument({ encryptedContent: encryptMemberToken(legacy, "document:legacy"), contentEncoding: "gzip-base64-v1", sha256 }, "document:legacy"), content);
});

test("staff lookup credentials are normalized, hashed and never treated as login credentials", () => {
  const token = newStaffSelectionToken();
  assert.equal(staffScanToken(`https://lookup.invalid/#${token.toLowerCase()}`), token);
  assert.equal(staffSelectionTokenHash(token), staffSelectionTokenHash(token.toLowerCase()));
  assert.equal(staffScanToken("KKMC1-" + "A".repeat(64)), "");
});

test("user fuzzy search handles partial, spaced and subsequence matches", () => {
  const users = [
    { _id: "1", fullName: "Mei Lin Tan", username: "mei.tan", email: "mei@example.com", role: "MANAGER" },
    { _id: "2", fullName: "Arif Rahman", username: "arahman", email: "arif@example.com", role: "ACCOUNTANT" },
  ];
  assert.equal(searchUsers(users, "mei lin")[0]._id, "1");
  assert.equal(searchUsers(users, "arhm")[0]._id, "2");
  assert.equal(searchUsers(users, "account")[0]._id, "2");
  assert.deepEqual(searchUsers(users, "nobody"), []);
});

test("expense precision, role separation and read-only write classification are enforced", () => {
  assert.deepEqual(expenseAmounts(10.6, 0.6, "MYR"), { amount: 10.6, taxAmount: 0.6, expenseAmount: 10 });
  assert.throws(() => expenseAmounts(10, 11, "MYR"));
  assert.equal(hasPermission("CASHIER", "expenses.submit"), true);
  assert.equal(hasPermission("CASHIER", "expenses.read"), true);
  assert.equal(hasPermission("CASHIER", "expenses.approve"), false);
  assert.equal(hasPermission("MANAGER", "expenses.approve"), true);
  assert.equal(hasPermission("ACCOUNTANT", "expenses.pay"), true);
  assert.equal(isWritePermission("expenses.submit"), true);
  assert.equal(isWritePermission("expenses.pay"), true);
  assert.equal(MAX_EXPENSE_ATTACHMENTS, 10);
});
