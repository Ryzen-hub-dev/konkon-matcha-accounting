import { createHash, randomBytes } from "node:crypto";
import { staffScanToken } from "@/lib/scan-codes";

export function newStaffSelectionToken() { return `KKSU1-${randomBytes(32).toString("hex").toUpperCase()}`; }
export function staffSelectionTokenHash(value: string) {
  const token = staffScanToken(value);
  if (!token) throw new Error("Invalid staff lookup credential.");
  return createHash("sha256").update(`staff-selection-v1:${token}`).digest("hex");
}
