import { createHash, randomBytes } from "node:crypto";

export const SCANNER_SESSION_MS = 24 * 60 * 60 * 1000;

export function createScannerToken() {
  return randomBytes(32).toString("base64url");
}

export function scannerTokenHash(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

export function normaliseScanCode(value: string) {
  const code = value.normalize("NFKC").trim().toUpperCase();
  if (!code || code.length > 128 || !/^[\x20-\x7E]+$/.test(code)) return "";
  return code;
}
