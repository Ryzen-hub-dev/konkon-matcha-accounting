import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { applyDocumentDimensions, dimensionDefaultsSchema, documentDimensionSelectionSchema, resolveProductDimensionSelections, type DocumentDimensionSelection } from "../lib/dimension-selection";

test("customer defaults accept an optional cost centre and project", () => {
  const costCentreId = new ObjectId().toHexString();
  assert.deepEqual(dimensionDefaultsSchema.parse(undefined), { costCentreId: "", projectId: "" });
  assert.equal(dimensionDefaultsSchema.safeParse({ costCentreId, projectId: "" }).success, true);
  assert.equal(dimensionDefaultsSchema.safeParse({ costCentreId: "invalid", projectId: "" }).success, false);
});

test("invoice dimension modes require a dimension only for a custom override", () => {
  const projectId = new ObjectId().toHexString();
  assert.deepEqual(documentDimensionSelectionSchema.parse(undefined), { mode: "CUSTOMER_DEFAULT", costCentreId: "", projectId: "" });
  assert.equal(documentDimensionSelectionSchema.safeParse({ mode: "CUSTOM", costCentreId: "", projectId }).success, true);
  assert.equal(documentDimensionSelectionSchema.safeParse({ mode: "CUSTOM", costCentreId: "", projectId: "" }).success, false);
  assert.equal(documentDimensionSelectionSchema.safeParse({ mode: "NONE", costCentreId: "", projectId: "" }).success, true);
});

test("document dimension snapshots tag every journal line without mutating the source", () => {
  const selection: DocumentDimensionSelection = {
    mode: "CUSTOM",
    source: "DOCUMENT_OVERRIDE",
    costCentre: { id: new ObjectId(), code: "WHOLESALE", name: "Wholesale" },
    project: { id: new ObjectId(), code: "EVENT", name: "Event" },
    resolvedAt: new Date("2026-09-19T00:00:00.000Z"),
  };
  const lines = [
    { accountCode: "1010", debit: 100, credit: 0 },
    { accountCode: "4000", debit: 0, credit: 100 },
  ];
  const tagged = applyDocumentDimensions(lines, selection);
  assert.notEqual(tagged, lines);
  assert.equal(tagged[0].costCentre?.code, "WHOLESALE");
  assert.equal(tagged[1].project?.code, "EVENT");
  assert.deepEqual(tagged[0].dimensionSource, { type: "DOCUMENT_OVERRIDE", mode: "CUSTOM" });
  assert.equal("costCentre" in lines[0], false);
});

test("explicitly unassigned invoice selections leave journal lines unchanged", () => {
  const lines = [{ accountCode: "4000", debit: 0, credit: 25 }];
  assert.equal(applyDocumentDimensions(lines, { mode: "NONE", source: "EXPLICIT_NONE", resolvedAt: new Date() }), lines);
});

test("product dimension defaults resolve into frozen POS snapshots in one lookup", async () => {
  const costCentreId = new ObjectId(), projectId = new ObjectId(), productId = new ObjectId();
  const documents = [
    { _id: costCentreId, type: "COST_CENTRE", code: "RETAIL", name: "Retail" },
    { _id: projectId, type: "PROJECT", code: "LAUNCH", name: "Launch" },
  ];
  let lookupCount = 0;
  const db = { collection: () => ({ find: () => ({ project: () => ({ toArray: async () => { lookupCount++; return documents; } }) }) }) } as any;
  const resolvedAt = new Date("2026-09-19T12:00:00.000Z");
  const selections = await resolveProductDimensionSelections(db, [{
    _id: productId,
    name: "Ceremonial tin",
    dimensionDefaults: { costCentre: { id: costCentreId }, project: { id: projectId } },
  }], undefined, resolvedAt);

  const selection = selections.get(productId.toHexString());
  assert.equal(lookupCount, 1);
  assert.equal(selection?.source, "PRODUCT_MASTER");
  assert.equal(selection?.costCentre?.code, "RETAIL");
  assert.equal(selection?.project?.code, "LAUNCH");
  assert.equal(selection?.resolvedAt, resolvedAt);
});

test("inactive product defaults block checkout instead of silently changing classification", async () => {
  const productId = new ObjectId(), archivedDimensionId = new ObjectId();
  const db = { collection: () => ({ find: () => ({ project: () => ({ toArray: async () => [] }) }) }) } as any;
  await assert.rejects(() => resolveProductDimensionSelections(db, [{
    _id: productId,
    name: "Archived default tin",
    dimensionDefaults: { costCentre: { id: archivedDimensionId } },
  }]), /inactive or invalid default accounting dimension/);
});
