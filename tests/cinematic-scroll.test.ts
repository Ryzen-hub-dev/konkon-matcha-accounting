import assert from "node:assert/strict";
import test from "node:test";
import { cinematicScrollState } from "../lib/cinematic-scroll";

test("cinematic scroll clamps progress and maps every business stage", () => {
  assert.deepEqual(cinematicScrollState(-1, 10), { progress: 0, stage: "0", time: 0 });
  assert.equal(cinematicScrollState(0.3, 10).stage, "1");
  assert.equal(cinematicScrollState(0.67, 10).stage, "2");
  assert.deepEqual(cinematicScrollState(2, 10), { progress: 1, stage: "2", time: 9.92 });
});
