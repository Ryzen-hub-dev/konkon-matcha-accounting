import { z } from "zod";

export const MAX_PRODUCT_IMAGE_BYTES = 240_000;

function validImageBytes(mime: string, bytes: Buffer) {
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return mime === "image/webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export function validProductImage(value: string) {
  if (!value) return true;
  const data = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (data) {
    const bytes = Buffer.from(data[2], "base64");
    return bytes.length > 0 && bytes.length <= MAX_PRODUCT_IMAGE_BYTES && validImageBytes(data[1], bytes);
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && host.includes(".") && host !== "localhost" && !host.endsWith(".local");
  } catch { return false; }
}

export const productImageSchema = z.string().trim().max(350_000).refine(validProductImage, {
  message: "Use a valid HTTPS image link or an uploaded JPEG, PNG or WebP below 240 KB.",
}).default("");
