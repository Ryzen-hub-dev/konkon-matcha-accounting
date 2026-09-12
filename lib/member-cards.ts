import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { memberScanToken } from "./scan-codes";

export const cardStyleSchema = z.object({
  label: z.string().trim().min(2).max(60),
  tier: z.string().trim().min(1).max(32),
  accentColor: z.string().regex(/^#[a-fA-F0-9]{6}$/),
});
export const cardCreateSchema = cardStyleSchema.extend({ memberId: z.string().regex(/^[a-f0-9]{24}$/i), clientRequestId: z.string().uuid() }).strict();
export const cardUpdateSchema = cardStyleSchema.partial().extend({ id: z.string().regex(/^[a-f0-9]{24}$/i), status: z.enum(["ACTIVE", "SUSPENDED", "VOID"]).optional() }).strict();

export function newMemberToken() { return `KKMC1-${randomBytes(32).toString("hex").toUpperCase()}`; }
export function memberTokenHash(value: string) {
  const token = memberScanToken(value);
  if (!token) throw new Error("Invalid member card.");
  return createHash("sha256").update(`member-card-v1:${token}`).digest("hex");
}
function key() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Card encryption is not configured.");
  return createHmac("sha256", secret).update("konkon-member-card-encryption-v1").digest();
}
export function encryptMemberToken(token: string, cardId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(cardId));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(value => value.toString("base64url")).join(".");
}
export function decryptMemberToken(encrypted: string, cardId: string) {
  const [iv, tag, ciphertext] = encrypted.split(".").map(part => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(Buffer.from(cardId)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
