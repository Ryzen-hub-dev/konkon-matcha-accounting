export function cinematicScrollState(progress: number, duration: number) {
  const safeProgress = Number.isFinite(progress)
    ? Math.min(1, Math.max(0, progress))
    : 0;
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  return {
    progress: safeProgress,
    stage: safeProgress < 0.3 ? "0" : safeProgress < 0.67 ? "1" : "2",
    time: safeProgress * Math.max(0, safeDuration - 0.08),
  } as const;
}
