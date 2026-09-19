import test from "node:test";
import assert from "node:assert/strict";
import { budgetActionSchema, budgetActual, budgetCreateSchema, budgetVariance, budgetYtdMonths, canApproveBudget, validateBudgetPrecision } from "../lib/budgets";
import { hasPermission } from "../lib/rbac";
import { isWritePermission } from "../lib/system-control";

test("budget inputs require unique accounts and twelve non-negative months", () => {
  const line = { accountCode: "4000", monthly: Array(12).fill(100) };
  assert.equal(budgetCreateSchema.safeParse({ year: 2027 }).success, true);
  assert.equal(budgetCreateSchema.safeParse({ year: 1999 }).success, false);
  assert.equal(budgetActionSchema.safeParse({ action: "SAVE", id: "a".repeat(24), expectedVersion: 1, name: "Operating plan", notes: "", lines: [line] }).success, true);
  assert.equal(budgetActionSchema.safeParse({ action: "SAVE", id: "a".repeat(24), expectedVersion: 1, name: "Operating plan", notes: "", lines: [line, line] }).success, false);
  assert.equal(budgetActionSchema.safeParse({ action: "SAVE", id: "a".repeat(24), expectedVersion: 1, name: "Operating plan", notes: "", lines: [{ ...line, monthly: Array(11).fill(100) }] }).success, false);
  assert.equal(budgetActionSchema.safeParse({ action: "SAVE", id: "a".repeat(24), expectedVersion: 1, name: "Operating plan", notes: "", lines: [{ ...line, monthly: [...Array(11).fill(100), -1] }] }).success, false);
});

test("budget actuals follow revenue and expense normal balances", () => {
  assert.equal(budgetActual("REVENUE", 20, 120, "MYR"), 100);
  assert.equal(budgetActual("EXPENSE", 120, 20, "MYR"), 100);
  assert.deepEqual(budgetVariance("REVENUE", 100, 120, "MYR"), { budget: 100, actual: 120, difference: 20, performance: 20, favourable: true });
  assert.deepEqual(budgetVariance("EXPENSE", 100, 120, "MYR"), { budget: 100, actual: 120, difference: 20, performance: -20, favourable: false });
  assert.deepEqual(budgetVariance("EXPENSE", 100, 80, "MYR"), { budget: 100, actual: 80, difference: -20, performance: 20, favourable: true });
});

test("budget YTD scope and currency precision are calendar safe", () => {
  assert.equal(budgetYtdMonths(2025, "2026-09-19"), 12);
  assert.equal(budgetYtdMonths(2026, "2026-09-19"), 9);
  assert.equal(budgetYtdMonths(2027, "2026-09-19"), 0);
  assert.deepEqual(validateBudgetPrecision([1.23, 0, 999.99], "MYR"), [1.23, 0, 999.99]);
  assert.throws(() => validateBudgetPrecision([1.234], "MYR"), /precision/);
  assert.deepEqual(validateBudgetPrecision([1, 2, 3], "JPY"), [1, 2, 3]);
  assert.throws(() => validateBudgetPrecision([1.1], "JPY"), /precision/);
});

test("budget permissions separate planning from Owner approval", () => {
  assert.equal(hasPermission("MANAGER", "budgets.read"), true);
  assert.equal(hasPermission("MANAGER", "budgets.write"), false);
  assert.equal(hasPermission("ACCOUNTANT", "budgets.write"), true);
  assert.equal(hasPermission("CASHIER", "budgets.read"), false);
  assert.equal(isWritePermission("budgets.write"), true);
  assert.equal(canApproveBudget("OWNER"), true);
  assert.equal(canApproveBudget("ADMIN"), false);
  assert.equal(canApproveBudget("ACCOUNTANT"), false);
});
