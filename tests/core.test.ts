import assert from "node:assert/strict";
import test from "node:test";
import { asMoney, makeDocumentNo } from "../lib/format";
import { canManageRole, hasPermission } from "../lib/rbac";

test("money values are rounded to accounting precision", () => {
  assert.equal(asMoney(10.005), 10.01);
  assert.equal(asMoney("46.90"), 46.9);
  assert.equal(asMoney("not-a-number"), 0);
});

test("document numbers are recognisable and collision resistant", () => {
  const first = makeDocumentNo("INV");
  const second = makeDocumentNo("INV");
  assert.match(first, /^INV-\d{8}-[A-F0-9]{6}$/);
  assert.notEqual(first, second);
});

test("cashier permissions stop at the counter", () => {
  assert.equal(hasPermission("CASHIER", "pos.sell"), true);
  assert.equal(hasPermission("CASHIER", "accounting.write"), false);
  assert.equal(hasPermission("CASHIER", "team.write"), false);
});

test("owner remains the only role that can manage administrators", () => {
  assert.equal(canManageRole("OWNER", "ADMIN"), true);
  assert.equal(canManageRole("ADMIN", "ADMIN"), false);
  assert.equal(canManageRole("ADMIN", "MANAGER"), true);
  assert.equal(canManageRole("OWNER", "OWNER"), false);
});
