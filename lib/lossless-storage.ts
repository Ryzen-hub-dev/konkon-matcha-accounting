import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { decryptMemberToken, encryptMemberToken } from "@/lib/member-cards";

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

type LosslessEnvelope = {
  version: 1;
  encoding: "br-max-v1" | "identity-v1";
  originalSize: number;
  sha256: string;
  encryptedPayload: string;
};

export type PackedLosslessPayload = {
  bytes: Buffer;
  encoding: LosslessEnvelope["encoding"];
  originalSize: number;
  storedSize: number;
  sha256: string;
};

export function sha256Bytes(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

/** Exact-byte preservation: compression is retained only when it actually saves space. */
export function packLosslessPayload(input: Buffer, context: string): PackedLosslessPayload {
  if (!input.length) throw new Error("The attachment is empty.");
  if (input.length > MAX_ATTACHMENT_BYTES) throw new Error("The attachment exceeds the 4 MB limit.");
  const compressed = brotliCompressSync(input, {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: input.length,
    },
  });
  const useCompression = compressed.length < input.length;
  const payload = useCompression ? compressed : input;
  const envelope: LosslessEnvelope = {
    version: 1,
    encoding: useCompression ? "br-max-v1" : "identity-v1",
    originalSize: input.length,
    sha256: sha256Bytes(input),
    encryptedPayload: encryptMemberToken(payload.toString("base64url"), context),
  };
  const bytes = Buffer.from(JSON.stringify(envelope));
  if (bytes.length > MAX_ENVELOPE_BYTES) throw new Error("The protected attachment exceeds the storage limit.");
  return { bytes, encoding: envelope.encoding, originalSize: input.length, storedSize: bytes.length, sha256: envelope.sha256 };
}

export function unpackLosslessPayload(bytes: Buffer, context: string) {
  if (!bytes.length || bytes.length > MAX_ENVELOPE_BYTES) throw new Error("The protected attachment is invalid.");
  let envelope: LosslessEnvelope;
  try { envelope = JSON.parse(bytes.toString("utf8")) as LosslessEnvelope; }
  catch { throw new Error("The protected attachment is invalid."); }
  if (envelope.version !== 1 || !["br-max-v1", "identity-v1"].includes(envelope.encoding) || !Number.isInteger(envelope.originalSize) || envelope.originalSize < 1 || envelope.originalSize > MAX_ATTACHMENT_BYTES || !/^[a-f0-9]{64}$/.test(envelope.sha256) || typeof envelope.encryptedPayload !== "string") {
    throw new Error("The protected attachment is invalid.");
  }
  const encryptedPlain = decryptMemberToken(envelope.encryptedPayload, context);
  const payload = Buffer.from(encryptedPlain, "base64url");
  const output = envelope.encoding === "br-max-v1"
    ? brotliDecompressSync(payload, { maxOutputLength: MAX_ATTACHMENT_BYTES })
    : payload;
  if (output.length !== envelope.originalSize || sha256Bytes(output) !== envelope.sha256) throw new Error("Attachment integrity check failed.");
  return output;
}
