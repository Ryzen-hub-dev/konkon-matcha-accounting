import assert from "node:assert/strict";
import test from "node:test";
import { konaGazeOffset } from "../lib/kona-gaze";

test("KONA gaze follows the pointer and stays within the eye artwork", () => {
  const right = konaGazeOffset(400, 200, 100, 200);
  assert.equal(right.x, 5.5);
  assert.equal(right.y, 0);

  const diagonal = konaGazeOffset(200, 300, 100, 200);
  assert.ok(diagonal.x > 0 && diagonal.x < 5.5);
  assert.ok(diagonal.y > 0 && diagonal.y < 4);
});

test("KONA gaze centres when the pointer reaches KONA or input is invalid", () => {
  assert.deepEqual(konaGazeOffset(400, 200, 100, 200, true), { x: 0, y: 0 });
  assert.deepEqual(konaGazeOffset(Number.NaN, 200, 100, 200), { x: 0, y: 0 });
});
