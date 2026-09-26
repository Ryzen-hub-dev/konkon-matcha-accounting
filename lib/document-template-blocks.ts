import { z } from "zod";

export const TEMPLATE_BLOCK_ALIGNMENTS = ["LEFT", "CENTER", "RIGHT"] as const;

export const templateCustomBlockSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{8,64}$/),
  kind: z.enum(["TEXT", "IMAGE"]),
  label: z.string().trim().min(1).max(60),
  content: z.string().max(280_000),
  alignment: z.enum(TEMPLATE_BLOCK_ALIGNMENTS).default("LEFT"),
}).superRefine((block, context) => {
  if (block.kind === "TEXT" && (!block.content.trim() || block.content.length > 1_000)) {
    context.addIssue({ code: "custom", path: ["content"], message: "Text components require 1–1,000 characters." });
  }
  if (block.kind === "IMAGE" && !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(block.content)) {
    context.addIssue({ code: "custom", path: ["content"], message: "Image components must contain an uploaded PNG, JPEG or WebP." });
  }
});

export type TemplateCustomBlock = z.infer<typeof templateCustomBlockSchema>;

export function customBlockKey(id: string) {
  return `CUSTOM:${id}`;
}

export function validateTemplateBlocks(
  order: string[],
  customBlocks: TemplateCustomBlock[],
  builtIns: readonly string[],
) {
  const expected = [...builtIns, ...customBlocks.map(block => customBlockKey(block.id))];
  const unique = new Set(order);
  if (unique.size !== order.length) return "Each document component can appear only once.";
  if (expected.some(key => !unique.has(key)) || order.some(key => !expected.includes(key))) {
    return "The document component order is incomplete.";
  }
  if (customBlocks.reduce((total, block) => total + block.content.length, 0) > 300_000) {
    return "Custom component content is too large. Keep the combined total under 220 KB.";
  }
  return null;
}

export function normaliseTemplateBlockOrder(
  value: unknown,
  builtIns: readonly string[],
  customBlocks: TemplateCustomBlock[],
) {
  const allowed = [...builtIns, ...customBlocks.map(block => customBlockKey(block.id))];
  const supplied = Array.isArray(value) ? value.map(String) : [];
  const ordered = supplied.filter((key, index) => allowed.includes(key) && supplied.indexOf(key) === index);
  return [...ordered, ...allowed.filter(key => !ordered.includes(key))];
}
