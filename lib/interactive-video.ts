export type NormalizedPointer = { x: number; y: number };

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
