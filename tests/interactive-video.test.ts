import assert from "node:assert/strict";
import test from "node:test";
import { dampedPlayhead, normalizePointer, videoPoseTarget } from "../lib/interactive-video";

test("pointer normalization stays inside the video control range", () => {
  assert.deepEqual(normalizePointer(-20, 1200, 1000, 800), { x: 0, y: 1 });
  assert.deepEqual(normalizePointer(500, 200, 1000, 800), { x: 0.5, y: 0.25 });
});

test("video pose mapping and damping remain bounded and smooth", () => {
  const target = videoPoseTarget({ x: 1, y: 0 }, 10);
  assert.equal(target, 9.2);
  assert.equal(dampedPlayhead(2, 6), 2.32);
  assert.equal(videoPoseTarget({ x: 0.5, y: 0.5 }, Number.NaN), 0);
});
