import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { encryptMemberToken, decryptMemberToken } from "./member-cards";

const MAX_DOCUMENT_BYTES = 1_000_000;
export function packDocument(content: string, context: string) {
  if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds storage limit.");
  const compressed = gzipSync(Buffer.from(content), { level: 6 }).toString("base64url");
  const useCompression = compressed.length < Buffer.byteLength(content);
  return { encryptedContent: encryptMemberToken(useCompression ? compressed : content, context), contentEncoding: useCompression ? "gzip-base64-v1" : "utf8-v1" };
}

export function unpackDocument(artifact: { encryptedContent: string; contentEncoding?: string; sha256: string }, context: string) {
  const plain = decryptMemberToken(artifact.encryptedContent, context);
  let content: string;
  if (artifact.contentEncoding === "gzip-base64-v1") content = gunzipSync(Buffer.from(plain, "base64url"), { maxOutputLength: MAX_DOCUMENT_BYTES }).toString("utf8");
  else if (!artifact.contentEncoding || artifact.contentEncoding === "utf8-v1") content = plain;
  else throw new Error("Unsupported document storage encoding.");
  if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES || createHash("sha256").update(content).digest("hex") !== artifact.sha256) throw new Error("Document integrity check failed.");
  return content;
}
