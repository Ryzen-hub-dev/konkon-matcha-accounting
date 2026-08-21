export type ScannerPurpose = "POS" | "INVENTORY";

export type RoutableScannerSession = {
  _id: string;
  purpose: ScannerPurpose;
  createdAt?: string | Date;
  connectedAt?: string | Date;
  lastUsedAt?: string | Date;
};

export function scannerPurposeFilter(purpose: ScannerPurpose) {
  return purpose === "POS" ? { $or: [{ purpose: "POS" }, { purpose: { $exists: false } }] } : { purpose: "INVENTORY" };
}

function timestamp(value: unknown) {
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") return 0;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

export function scannerActivityAt(session: Record<string, unknown>) {
  return Math.max(
    timestamp(session.lastUsedAt),
    timestamp(session.connectedAt),
    timestamp(session.createdAt),
  );
}

export function selectScannerSession<T extends RoutableScannerSession>(
  sessions: readonly T[],
  purpose: ScannerPurpose,
  preferredId = "",
  currentId = "",
) {
  return sessions.find((session) => session._id === preferredId)
    || sessions.find((session) => session._id === currentId && session.purpose === purpose)
    || sessions[0];
}
