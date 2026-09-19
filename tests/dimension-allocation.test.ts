import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { applyDimensionAllocation, dimensionRuleAuditId, dimensionRuleCreateSchema, dimensionRuleUpdateSchema, type ResolvedDimensionAllocation } from "../lib/dimension-allocation";

test("allocation rules require an exact source target and at least one dimension", () => {
  const costCentreId = new ObjectId().toHexString();
  const projectId = new ObjectId().toHexString();
  assert.equal(dimensionRuleCreateSchema.safeParse({ source: "POS_LOCATION", matchKey: new ObjectId().toHexString(), costCentreId, projectId: "" }).success, true);
  assert.equal(dimensionRuleCreateSchema.safeParse({ source: "EXPENSE_ACCOUNT", matchKey: "6000", allocations: [{ percentage: 60, costCentreId }, { percentage: 40, projectId }] }).success, true);
  assert.equal(dimensionRuleCreateSchema.safeParse({ source: "EXPENSE_ACCOUNT", matchKey: "6000", allocations: [{ percentage: 60, costCentreId }, { percentage: 39.99, projectId }] }).success, false);
  assert.equal(dimensionRuleCreateSchema.safeParse({ source: "EXPENSE_ACCOUNT", matchKey: "6000", allocations: [{ percentage: 50, costCentreId }, { percentage: 50, costCentreId }] }).success, false);
  assert.equal(dimensionRuleCreateSchema.safeParse({ source: "UNKNOWN", matchKey: "HQ", costCentreId }).success, false);
  assert.equal(dimensionRuleCreateSchema.safeParse({ source: "EXPENSE_ACCOUNT", matchKey: "6000", costCentreId: "", projectId: "" }).success, false);
  assert.equal(dimensionRuleUpdateSchema.safeParse({ id: new ObjectId().toHexString(), expectedVersion: 2, active: false, costCentreId, projectId: "" }).success, true);
  assert.equal(dimensionRuleUpdateSchema.safeParse({ id: new ObjectId().toHexString(), expectedVersion: 0, active: true, costCentreId, projectId: "" }).success, false);
});

test("automatic allocation snapshots every journal line without changing amounts", () => {
  const allocation: ResolvedDimensionAllocation = {
    costCentre: { id: new ObjectId(), code: "SHOP", name: "Retail shop" },
    project: { id: new ObjectId(), code: "LAUNCH", name: "Launch campaign" },
    rule: { id: new ObjectId(), source: "POS_LOCATION", matchKey: new ObjectId().toHexString(), version: 3 },
  };
  const lines = [
    { accountCode: "1000", debit: 120, credit: 0 },
    { accountCode: "4000", debit: 0, credit: 120 },
  ];
  const tagged = applyDimensionAllocation(lines, allocation);
  assert.equal(tagged.length, 2);
  assert.equal(tagged[0].debit, 120);
  assert.equal(tagged[1].credit, 120);
  assert.equal(tagged[0].costCentre?.code, "SHOP");
  assert.equal(tagged[1].project?.code, "LAUNCH");
  assert.equal(tagged[0].dimensionRule?.version, 3);
  assert.equal("costCentre" in lines[0], false);
  assert.equal(dimensionRuleAuditId(allocation), allocation.rule.id.toHexString());
});

test("percentage allocation distributes minor units deterministically and preserves journal balance", () => {
  const allocation: ResolvedDimensionAllocation = {
    allocations: [
      { percentage: 33.33, costCentre: { id: new ObjectId(), code: "SHOP", name: "Retail shop" } },
      { percentage: 33.33, costCentre: { id: new ObjectId(), code: "OFFICE", name: "Head office" } },
      { percentage: 33.34, project: { id: new ObjectId(), code: "LAUNCH", name: "Launch campaign" } },
    ],
    rule: { id: new ObjectId(), source: "EXPENSE_ACCOUNT", matchKey: "6000", version: 2 },
  };
  const allocated = applyDimensionAllocation([
    { accountCode: "6000", debit: 10.01, credit: 0 },
    { accountCode: "2000", debit: 0, credit: 10.01 },
  ], allocation, "MYR");

  assert.equal(allocated.length, 6);
  assert.deepEqual(allocated.slice(0, 3).map(line => line.debit), [3.34, 3.33, 3.34]);
  assert.deepEqual(allocated.slice(3).map(line => line.credit), [3.34, 3.33, 3.34]);
  assert.equal(allocated.reduce((sum, line) => sum + Number(line.debit), 0), 10.01);
  assert.equal(allocated.reduce((sum, line) => sum + Number(line.credit), 0), 10.01);
  assert.equal(allocated[2].project?.code, "LAUNCH");
  assert.deepEqual(allocated.map(line => line.dimensionSplit?.index), [1, 2, 3, 1, 2, 3]);
});

test("percentage allocation drops zero-value fragments without losing a minor unit", () => {
  const allocation: ResolvedDimensionAllocation = {
    allocations: [
      { percentage: 33.33, costCentre: { id: new ObjectId(), code: "A", name: "A" } },
      { percentage: 33.33, costCentre: { id: new ObjectId(), code: "B", name: "B" } },
      { percentage: 33.34, costCentre: { id: new ObjectId(), code: "C", name: "C" } },
    ],
    rule: { id: new ObjectId(), source: "PURCHASE_LOCATION", matchKey: new ObjectId().toHexString(), version: 1 },
  };
  const allocated = applyDimensionAllocation([
    { accountCode: "1000", debit: 0.01, credit: 0 },
    { accountCode: "2000", debit: 0, credit: 0.01 },
  ], allocation, "MYR");

  assert.equal(allocated.length, 2);
  assert.equal(allocated[0].costCentre?.code, "C");
  assert.equal(allocated[0].debit, 0.01);
  assert.equal(allocated[1].credit, 0.01);
});

test("journals remain unchanged when no active allocation rule resolves", () => {
  const lines = [{ accountCode: "6000", debit: 25, credit: 0 }];
  assert.equal(applyDimensionAllocation(lines, null), lines);
  assert.equal(dimensionRuleAuditId(null), "");
});
