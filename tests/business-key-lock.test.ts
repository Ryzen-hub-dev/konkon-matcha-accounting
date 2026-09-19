import assert from "node:assert/strict";
import test from "node:test";
import { businessKeyLockId } from "../lib/business-key-lock";

test("business-key locks normalise equivalent budget and dimension identities", () => {
  assert.equal(businessKeyLockId("budget_year", 2027), "BUDGET_YEAR:2027");
  assert.equal(
    businessKeyLockId("accounting_dimension", " cost_centre ", " retail kl "),
    businessKeyLockId("ACCOUNTING_DIMENSION", "COST_CENTRE", "RETAIL KL"),
  );
});

test("business-key lock identifiers escape separators and stay inside MongoDB key bounds", () => {
  assert.equal(businessKeyLockId("dimension_rule", "expense_account", "60:00"), "DIMENSION_RULE:EXPENSE_ACCOUNT:60%3A00");
  assert.ok(businessKeyLockId("scope", "x".repeat(500)).length <= 240);
});
