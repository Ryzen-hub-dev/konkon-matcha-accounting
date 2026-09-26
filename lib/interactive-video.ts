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
  const smooth = x * x * (3 - 2 * x);
  const inset = Math.min(duration * 0.012, 0.1);
  return inset + (1 - smooth) * (duration - inset * 2);
}
