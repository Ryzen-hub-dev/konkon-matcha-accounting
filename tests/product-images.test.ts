import assert from "node:assert/strict";
import test from "node:test";
import { productImageSchema, validProductImage } from "../lib/product-images";

test("store images accept HTTPS links and verified raster data only", () => {
  assert.equal(productImageSchema.safeParse("https://cdn.example.com/tea.webp").success, true);
  assert.equal(validProductImage("http://cdn.example.com/tea.webp"), false);
  assert.equal(validProductImage("https://localhost/tea.webp"), false);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from("image")]);
  assert.equal(validProductImage(`data:image/webp;base64,${webp.toString("base64")}`), true);
  assert.equal(validProductImage(`data:image/png;base64,${Buffer.from("not an image").toString("base64")}`), false);
});
