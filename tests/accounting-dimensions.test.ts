import test from "node:test";
import assert from "node:assert/strict";
import { buildDimensionReport, dimensionCreateSchema, dimensionNormalBalance, dimensionUpdateSchema, journalDimensionIdSchema } from "../lib/accounting-dimensions";
import { accessLevel, ACCESS_AREAS, hasPermission } from "../lib/rbac";

test("dimension masters normalise stable codes and validate optimistic updates", () => {
  const created = dimensionCreateSchema.parse({ type: "COST_CENTRE", code: " retail-kl ", name: "Retail KL", description: "Front counter" });
  assert.equal(created.code, "RETAIL-KL");
  assert.equal(dimensionCreateSchema.safeParse({ type: "PROJECT", code: "bad code", name: "Campaign" }).success, false);
  assert.equal(dimensionUpdateSchema.safeParse({ id: "a".repeat(24), expectedVersion: 2, name: "Retail", description: "", active: false }).success, true);
  assert.equal(dimensionUpdateSchema.safeParse({ id: "a".repeat(24), expectedVersion: 0, name: "Retail", description: "", active: true }).success, false);
  assert.equal(journalDimensionIdSchema.safeParse("").success, true);
  assert.equal(journalDimensionIdSchema.safeParse("a".repeat(24)).success, true);
});

test("dimension normal balances preserve revenue and expense accounting signs", () => {
  assert.equal(dimensionNormalBalance("REVENUE", 20, 120, "MYR"), 100);
  assert.equal(dimensionNormalBalance("EXPENSE", 120, 20, "MYR"), 100);
  assert.equal(dimensionNormalBalance("REVENUE", 20, 0, "MYR"), -20);
});

test("dimension reports include archived history and disclose unassigned activity", () => {
  const report = buildDimensionReport("COST_CENTRE", [
    { type: "COST_CENTRE", code: "SHOP", name: "Shop", active: true },
    { type: "COST_CENTRE", code: "HQ", name: "Head office", active: false },
    { type: "PROJECT", code: "EVENT", name: "Event", active: true },
  ], [
    { code: "SHOP", name: "Shop", accountCode: "4000", debit: 0, credit: 100, activity: 100, lineCount: 1 },
    { code: "SHOP", name: "Shop", accountCode: "6000", debit: 30, credit: 0, activity: 30, lineCount: 1 },
    { code: "HQ", name: "Head office", accountCode: "6000", debit: 10, credit: 0, activity: 10, lineCount: 1 },
    { accountCode: "4000", debit: 0, credit: 50, activity: 50, lineCount: 1 },
  ], new Map([["4000", "REVENUE"], ["6000", "EXPENSE"]]), "MYR");
  assert.deepEqual(report.rows.map(row => row.code), ["SHOP", "HQ", "UNASSIGNED"]);
  assert.deepEqual(report.rows.find(row => row.code === "SHOP"), { code: "SHOP", name: "Shop", active: true, assigned: true, revenue: 100, expense: 30, profit: 70, activity: 130, lineCount: 2 });
  assert.equal(report.rows.find(row => row.code === "HQ")?.active, false);
  assert.equal(report.summary.revenue, 150);
  assert.equal(report.summary.expense, 40);
  assert.equal(report.summary.profit, 110);
  assert.equal(report.summary.unassignedActivity, 50);
  assert.ok(Math.abs(report.summary.assignmentRate - 73.6842105263) < 0.0001);
});

test("dimension access is readable by managers and maintained by accounting roles", () => {
  const area = ACCESS_AREAS.find(item => item.label === "Cost centres & projects")!;
  assert.equal(hasPermission("MANAGER", "reports.read"), true);
  assert.equal(hasPermission("MANAGER", "accounting.write"), false);
  assert.equal(accessLevel("MANAGER", area), "VIEW");
  assert.equal(accessLevel("ACCOUNTANT", area), "MANAGE");
  assert.equal(hasPermission("CASHIER", "reports.read"), false);
});
