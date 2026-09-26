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

export function videoPoseTarget(pointer: NormalizedPointer, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const pose = 0.08 + (pointer.x * 0.72 + (1 - pointer.y) * 0.28) * 0.84;
  return clamp01(pose) * duration;
}

export function dampedPlayhead(current: number, target: number, damping = 0.08) {
  return current + (target - current) * clamp01(damping);
}
