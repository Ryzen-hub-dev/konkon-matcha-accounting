export type KonaGazeOffset = { x: number; y: number };

export function konaGazeOffset(
  pointerX: number,
  pointerY: number,
  centerX: number,
  centerY: number,
  frozen = false,
  maxDistance = 5.5,
): KonaGazeOffset {
  if (
    frozen ||
    !Number.isFinite(pointerX) ||
    !Number.isFinite(pointerY) ||
    !Number.isFinite(centerX) ||
    !Number.isFinite(centerY) ||
    !Number.isFinite(maxDistance) ||
    maxDistance <= 0
  ) return { x: 0, y: 0 };

  const dx = pointerX - centerX;
  const dy = pointerY - centerY;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: 0, y: 0 };

  const strength = Math.min(1, distance / 180) * maxDistance;
  return {
    x: (dx / distance) * strength,
    y: (dy / distance) * strength * 0.72,
  };
}
