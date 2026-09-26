import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateMediaCalibration,
  correctedPoseFrame,
  coverDrawRect,
  frameDamping,
  incrementalScrubTarget,
  nativeCanvasPixelRatio,
  normalizePointer,
} from "../lib/interactive-video";

test("absolute pointer poses always auto-correct back to the neutral frame", () => {
  assert.equal(correctedPoseFrame(0, 240), 0);
  assert.equal(correctedPoseFrame(0.5, 240), 119.5);
  assert.equal(correctedPoseFrame(1, 240), 239);
  assert.equal(correctedPoseFrame(3, 240), 239);
});

test("canvas cover geometry preserves the source aspect ratio and focal point", () => {
  assert.deepEqual(coverDrawRect(1280, 720, 1280, 720), {
    x: 0,
    y: 0,
    width: 1280,
    height: 720,
  });
  const portrait = coverDrawRect(1280, 720, 390, 844);
  assert.equal(portrait.height, 844);
  assert.ok(portrait.x < 0);
  assert.equal(portrait.y, 0);
});

test("canvas resolution never exceeds the detail available in the source frames", () => {
  assert.equal(nativeCanvasPixelRatio(1280, 720, 1280, 720, 2), 1);
  assert.equal(nativeCanvasPixelRatio(1280, 720, 640, 360, 3), 2);
  assert.equal(nativeCanvasPixelRatio(1280, 720, 1920, 1080, 2), 2 / 3);
  assert.ok(Math.abs(nativeCanvasPixelRatio(1280, 720, 390, 844, 3) - 720 / 844) < 1e-12);
});

test("media calibration keeps modest overscan and corrects portrait focus", () => {
  const desktop = calculateMediaCalibration(1920, 1080, 1440, 900, 1);
  const portrait = calculateMediaCalibration(1920, 1080, 390, 844, 3);
  assert.ok(desktop.scale > 1 && desktop.scale <= 1.022);
  assert.ok(desktop.focusY >= 49.5 && desktop.focusY <= 50);
  assert.ok(portrait.focusY < 50);
  assert.equal(portrait.seekIntervalMs, 1000 / 24);
});

test("pointer normalization stays inside the video control range", () => {
  assert.deepEqual(normalizePointer(-20, 1200, 1000, 800), { x: 0, y: 1 });
  assert.deepEqual(normalizePointer(500, 200, 1000, 800), { x: 0.5, y: 0.25 });
});

test("incremental scrub targeting clamps to seek-safe video insets", () => {
  assert.equal(incrementalScrubTarget(5, 100, 1000, 10), 5.8);
  assert.equal(incrementalScrubTarget(9.2, 1000, 1000, 10), 9.65);
  assert.equal(incrementalScrubTarget(0.8, -1000, 1000, 10), 0.35);
  assert.equal(incrementalScrubTarget(4, 20, 0, Number.NaN), 0);
});

test("frame damping is refresh-rate independent and never overshoots", () => {
  const sixtyHz = frameDamping(0, 1, 1000 / 60, 12);
  const oneTwentyHz = frameDamping(0, 1, 1000 / 120, 12);
  assert.ok(sixtyHz > oneTwentyHz);
  assert.ok(sixtyHz > 0 && sixtyHz < 1);
  assert.equal(frameDamping(4, 10, 0, 12), 4);
});
