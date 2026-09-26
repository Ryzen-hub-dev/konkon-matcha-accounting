export type NormalizedPointer = { x: number; y: number };
export type MediaCalibration = {
  scale: number;
  focusX: number;
  focusY: number;
  seekIntervalMs: number;
};
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function normalizePointer(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
): NormalizedPointer {
  return {
    x: clamp01(clientX / Math.max(1, viewportWidth)),
    y: clamp01(clientY / Math.max(1, viewportHeight)),
  };
}

export function incrementalScrubTarget(
  currentTarget: number,
  deltaX: number,
  viewportWidth: number,
  duration: number,
  sensitivity = 0.8,
) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const inset = Math.min(duration * 0.06, 0.35);
  const delta = (deltaX / Math.max(1, viewportWidth)) * sensitivity * duration;
  return Math.min(duration - inset, Math.max(inset, currentTarget + delta));
}

export function frameDamping(
  current: number,
  target: number,
  deltaMs: number,
  responsiveness = 12,
) {
  const safeDelta = Math.min(64, Math.max(0, deltaMs)) / 1000;
  const alpha = 1 - Math.exp(-Math.max(0, responsiveness) * safeDelta);
  return current + (target - current) * alpha;
}

export function calculateMediaCalibration(
  videoWidth: number,
  videoHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio = 1,
): MediaCalibration {
  const safeVideoWidth = Math.max(1, videoWidth);
  const safeVideoHeight = Math.max(1, videoHeight);
  const safeViewportWidth = Math.max(1, viewportWidth);
  const safeViewportHeight = Math.max(1, viewportHeight);
  const videoAspect = safeVideoWidth / safeVideoHeight;
  const viewportAspect = safeViewportWidth / safeViewportHeight;
  const portraitCrop = Math.max(0, videoAspect / viewportAspect - 1);
  const landscapeCrop = Math.max(0, viewportAspect / videoAspect - 1);
  const overscan = Math.min(0.022, Math.max(0.008, 10 / Math.min(safeViewportWidth, safeViewportHeight)));
  const densityRelief = Math.min(0.004, Math.max(0, devicePixelRatio - 1) * 0.002);

  return {
    scale: Number((1 + Math.max(0.006, overscan - densityRelief)).toFixed(4)),
    focusX: Number((50 + Math.min(2.4, landscapeCrop * 1.2)).toFixed(2)),
    focusY: Number((50 - Math.min(3.2, portraitCrop * 1.8)).toFixed(2)),
    seekIntervalMs: devicePixelRatio >= 2 ? 1000 / 24 : 1000 / 30,
  };
}

export function correctedPoseTime(pointerX: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const x = clamp01(pointerX);
  const center = duration * 0.5;
  const centerDeadZone = 0.04;
  const leftBoundary = 0.5 - centerDeadZone;
  const rightBoundary = 0.5 + centerDeadZone;
  const counterTurnGap = duration * 0.12;
  const inset = Math.min(duration * 0.035, 0.35);

  // The generated source briefly counter-rotates its eyes around the midpoint.
  // Hold a clean front-facing pose over KONA's head, then map each side only
  // into the monotonic portions of the clip.
  if (x >= leftBoundary && x <= rightBoundary) return center;
  if (x < leftBoundary) {
    const progress = clamp01((leftBoundary - x) / leftBoundary);
    const eased = progress * progress * (3 - 2 * progress);
    return center + counterTurnGap + eased * (duration - inset - center - counterTurnGap);
  }

  const progress = clamp01((x - rightBoundary) / (1 - rightBoundary));
  const eased = progress * progress * (3 - 2 * progress);
  return center - counterTurnGap - eased * (center - counterTurnGap - inset);
}

export function skipCounterTurnFrames(current: number, target: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const center = duration * 0.5;
  const gap = duration * 0.12;
  const lower = center - gap;
  const upper = center + gap;
  const centerTolerance = duration * 0.001;

  if (Math.abs(target - center) <= centerTolerance) return center;
  if (target <= lower && current > lower) return lower;
  if (target >= upper && current < upper) return upper;
  return current;
}
