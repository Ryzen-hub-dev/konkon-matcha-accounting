import { createHmac, timingSafeEqual } from "node:crypto";

function hmacKey() {
  const secret = process.env.IDENTITY_LOOKUP_SECRET || process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("The identity lookup secret must contain at least 32 characters.");
  return secret;
}

export function normalisePrivateIdentifier(value: string) {
  return value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function privateIdentifierHash(value: string) {
  const normalised = normalisePrivateIdentifier(value);
  if (!normalised) return "";
  return createHmac("sha256", hmacKey()).update(`member-identity:v1:${normalised}`).digest("base64url");
}

export function constantTimeTokenMatch(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
