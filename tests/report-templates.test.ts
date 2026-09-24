import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultReportTemplate,
  reportTemplateMutationSchema,
} from "../lib/report-templates";

test("report designer accepts only sections belonging to the selected statement", () => {
  const template = defaultReportTemplate("PROFIT_LOSS");
  assert.equal(
    reportTemplateMutationSchema.safeParse({ action: "SAVE", ...template })
      .success,
    true,
  );
  assert.equal(
    reportTemplateMutationSchema.safeParse({
      action: "SAVE",
      ...template,
      sections: ["REVENUE", "ASSETS"],
    }).success,
    false,
  );
  assert.equal(
    reportTemplateMutationSchema.safeParse({
      action: "SAVE",
      ...template,
      sections: ["REVENUE", "REVENUE"],
    }).success,
    false,
  );
});
