import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { packDocument, unpackDocument } from "../lib/document-storage";
import { encryptMemberToken } from "../lib/member-cards";
import { auditExpiry, EXPIRING_AUDIT_ACTIONS } from "../lib/data-retention";

process.env.AUTH_SECRET = "test-only-document-storage-secret-at-least-40-chars";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
test("documents compress before encryption and recover exact Unicode bytes; short and legacy documents remain readable", () => {
  for (const content of ["Small invoice", '<Invoice>抹茶 café 🍵 &amp; 123.45</Invoice>\r\n'.repeat(500)]) {
    const packed = packDocument(content, "einvoice:test");
    assert.equal(unpackDocument({ ...packed, sha256: hash(content) }, "einvoice:test"), content);
    assert.ok(!packed.encryptedContent.includes("Invoice"));
    if (content.length > 1000) { assert.equal(packed.contentEncoding, "br-base64-v2"); assert.ok(packed.encryptedContent.length < Buffer.byteLength(content) / 5); }
    else assert.equal(packed.contentEncoding, "utf8-v1");
    assert.equal(unpackDocument({ encryptedContent: encryptMemberToken(content, "einvoice:test"), sha256: hash(content) }, "einvoice:test"), content);
  }
});
test("document storage rejects cross-document replay, corrupt hashes, unknown formats and oversized decompression", () => {
  const packed = packDocument("Invoice 123".repeat(500), "einvoice:test");
  assert.throws(() => unpackDocument({ ...packed, sha256: "bad" }, "einvoice:test"));
  assert.throws(() => unpackDocument({ ...packed, sha256: "bad" }, "einvoice:another"));
  assert.throws(() => unpackDocument({ ...packed, contentEncoding: "unknown", sha256: "bad" }, "einvoice:test"));
  assert.throws(() => packDocument("x".repeat(1_000_001), "einvoice:test"));
  const bomb = "x".repeat(1_000_001);
  assert.throws(() => unpackDocument({ encryptedContent: encryptMemberToken(gzipSync(bomb).toString("base64url"), "einvoice:test"), contentEncoding: "gzip-base64-v1", sha256: hash(bomb) }, "einvoice:test"));
});
test("only explicitly temporary operational audit actions expire; financial and account-change evidence does not", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  for (const action of EXPIRING_AUDIT_ACTIONS) assert.equal(auditExpiry(action, now)?.getTime(), now.getTime() + 90 * 86_400_000);
  for (const action of ["sale.create", "refund.create", "invoice.create", "user.archive", "member.archive", "user.password_reset", "settings.update", "unknown.action"]) assert.equal(auditExpiry(action, now), undefined);
});
