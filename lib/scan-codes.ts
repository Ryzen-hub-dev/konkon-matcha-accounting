export function receiptScanToken(value: string) {
  return value.trim().match(/(?:^|[=#/])(KKR1-[a-f0-9]{24}-[a-f0-9]{64})(?:$|[&\s])/i)?.[1].toLowerCase() || "";
}

export function memberScanToken(value: string) {
  return value.trim().match(/(?:^|[=#/])(KKMC1-[a-f0-9]{64})(?:$|[&\s])/i)?.[1].toUpperCase() || "";
}

/** Static staff lookup token. It selects a user but never authenticates or grants access. */
export function staffScanToken(value: string) {
  return value.trim().match(/(?:^|[=#/])(KKSU1-[a-f0-9]{64})(?:$|[&\s])/i)?.[1].toUpperCase() || "";
}

export const NFC_BINDING_SOURCES = ["NFC_SERIAL", "NDEF_DIGEST"] as const;
export type NfcBindingSource = typeof NFC_BINDING_SOURCES[number];

/** A browser-derived digest for an existing NFC tag. It never contains the tag UID or NDEF payload. */
export function memberBindingScanToken(value: string): { source: NfcBindingSource; fingerprint: string } | null {
  const code = value.trim().toUpperCase().replace(/^KKMCARD:\/\//, "");
  const match = /^KKNT1-(S|N)-([A-F0-9]{64})$/.exec(code);
  if (!match) return null;
  return { source: match[1] === "S" ? "NFC_SERIAL" : "NDEF_DIGEST", fingerprint: match[2].toLowerCase() };
}

export function receiptTokenId(token: string) {
  return /^kkr1-[a-f0-9]{24}-[a-f0-9]{64}$/i.test(token) ? token.split("-")[1].toLowerCase() : "";
}

export function cartQuantity(value: string, stock: number) {
  if (!/^\d+$/.test(value.trim())) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= Math.min(999, stock) ? quantity : null;
}
