export function receiptScanToken(value: string) {
  return value.trim().match(/(?:^|[=#/])(KKR1-[a-f0-9]{24}-[a-f0-9]{64})(?:$|[&\s])/i)?.[1].toLowerCase() || "";
}

export function memberScanToken(value: string) {
  return value.trim().match(/(?:^|[=#/])(KKMC1-[a-f0-9]{64})(?:$|[&\s])/i)?.[1].toUpperCase() || "";
}

export function receiptTokenId(token: string) {
  return /^kkr1-[a-f0-9]{24}-[a-f0-9]{64}$/i.test(token) ? token.split("-")[1].toLowerCase() : "";
}

export function cartQuantity(value: string, stock: number) {
  if (!/^\d+$/.test(value.trim())) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= Math.min(999, stock) ? quantity : null;
}
