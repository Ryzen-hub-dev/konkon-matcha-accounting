const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type EmvQrField = { id: string; value: string };

export type DuitNowQrInspection = {
  pointOfInitiation: "STATIC" | "DYNAMIC";
  merchantCategoryCode: string;
  currency: "MYR";
  amount: string;
  hasAmount: boolean;
  recipientType: "P2P" | "MERCHANT";
  hasDataIntegrityCheck: boolean;
  crcValid: boolean;
};

function ascii(bytes: Uint8Array) {
  return String.fromCharCode(...bytes);
}

export function parseEmvQr(payload: string): EmvQrField[] {
  if (!payload || payload !== payload.trim() || payload.length > 4_096 || /[\u0000-\u001F\u007F]/.test(payload)) {
    throw new Error("The QR payload is not a supported EMV payment code.");
  }
  const bytes = encoder.encode(payload);
  const fields: EmvQrField[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < bytes.length) {
    if (cursor + 4 > bytes.length) throw new Error("The QR payload ends inside an EMV field header.");
    const id = ascii(bytes.slice(cursor, cursor + 2));
    const lengthText = ascii(bytes.slice(cursor + 2, cursor + 4));
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(lengthText)) throw new Error("The QR payload contains an invalid EMV field header.");
    const length = Number(lengthText);
    const valueEnd = cursor + 4 + length;
    if (valueEnd > bytes.length) throw new Error("The QR payload contains an invalid EMV field length.");
    if (seen.has(id)) throw new Error(`The QR payload repeats EMV field ${id}.`);
    let value = "";
    try { value = decoder.decode(bytes.slice(cursor + 4, valueEnd)); }
    catch { throw new Error(`EMV field ${id} is not valid UTF-8.`); }
    fields.push({ id, value });
    seen.add(id);
    cursor = valueEnd;
  }
  return fields;
}

export function encodeEmvField(field: EmvQrField) {
  if (!/^\d{2}$/.test(field.id)) throw new Error("EMV field IDs must contain two digits.");
  const length = encoder.encode(field.value).length;
  if (length > 99) throw new Error(`EMV field ${field.id} is longer than 99 bytes.`);
  return `${field.id}${String(length).padStart(2, "0")}${field.value}`;
}

export function duitNowCrc16(payloadWithoutCrcValue: string) {
  let crc = 0xffff;
  for (const byte of encoder.encode(payloadWithoutCrcValue)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function inspectFields(payload: string) {
  const fields = parseEmvQr(payload);
  const values = new Map(fields.map((field) => [field.id, field.value]));
  if (fields[0]?.id !== "00" || values.get("00") !== "02") throw new Error("This is not a DuitNow merchant-presented QR payload.");
  if (!['11', '12'].includes(values.get("01") || "")) throw new Error("The DuitNow point-of-initiation method is missing or invalid.");
  const merchantAccount = fields.find((field) => Number(field.id) >= 26 && Number(field.id) <= 51);
  if (!merchantAccount) throw new Error("The DuitNow merchant account field is missing.");
  const merchantValues = new Map(parseEmvQr(merchantAccount.value).map((field) => [field.id, field.value]));
  if (merchantValues.get("00") !== "A0000006150001") throw new Error("The QR does not contain the Malaysian DuitNow application identifier.");
  if (!/^\d{4}$/.test(values.get("52") || "")) throw new Error("The DuitNow merchant category code is invalid.");
  if (values.get("53") !== "458" || values.get("58") !== "MY") throw new Error("Amount locking currently supports Malaysian Ringgit DuitNow QR only.");
  if (!values.get("59") || !values.get("60")) throw new Error("The DuitNow recipient display fields are incomplete.");
  const crc = fields.at(-1);
  if (crc?.id !== "63" || !/^[0-9A-Fa-f]{4}$/.test(crc.value)) throw new Error("The DuitNow CRC field must be last.");
  const crcValid = duitNowCrc16(payload.slice(0, -4)) === crc.value.toUpperCase();
  if (!crcValid) throw new Error("The DuitNow QR checksum is invalid. Import the original QR again.");
  return { fields, values, crcValid };
}

export function inspectDuitNowQr(payload: string): DuitNowQrInspection {
  const { values, crcValid } = inspectFields(payload);
  const mcc = values.get("52") || "";
  return {
    pointOfInitiation: values.get("01") === "12" ? "DYNAMIC" : "STATIC",
    merchantCategoryCode: mcc,
    currency: "MYR",
    amount: values.get("54") || "",
    hasAmount: values.has("54"),
    recipientType: mcc === "0000" ? "P2P" : "MERCHANT",
    hasDataIntegrityCheck: values.has("82"),
    crcValid,
  };
}

function formatDuitNowAmount(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("The DuitNow amount must be greater than zero.");
  const formatted = (Math.round((amount + Number.EPSILON) * 100) / 100).toFixed(2);
  if (formatted.length > 13) throw new Error("The DuitNow amount exceeds the supported QR field length.");
  return formatted;
}

export function buildAmountLockedDuitNowQr(payload: string, amount: number, currency: string) {
  if (currency !== "MYR") throw new Error("DuitNow amount locking requires MYR settlement.");
  const { fields, values } = inspectFields(payload);
  if (values.has("82")) throw new Error("This recipient QR contains an integrity field and cannot be safely rewritten without its issuer.");
  const formattedAmount = formatDuitNowAmount(amount);
  const next: EmvQrField[] = [];
  for (const field of fields) {
    if (field.id === "54" || field.id === "63") continue;
    next.push(field);
    if (field.id === "53") next.push({ id: "54", value: formattedAmount });
  }
  if (!next.some((field) => field.id === "54")) throw new Error("The DuitNow currency field is missing.");
  const crcInput = `${next.map(encodeEmvField).join("")}6304`;
  const result = `${crcInput}${duitNowCrc16(crcInput)}`;
  inspectFields(result);
  return {
    payload: result,
    amount: formattedAmount,
    amountLocked: true as const,
    pointOfInitiation: values.get("01") === "12" ? "DYNAMIC" as const : "STATIC" as const,
  };
}
