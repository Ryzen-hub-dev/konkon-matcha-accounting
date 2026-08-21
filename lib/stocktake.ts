import { z } from "zod";

export const stocktakeInputSchema = z.object({
  note: z.string().trim().max(300).default(""),
  lines: z.array(z.object({
    productId: z.string().regex(/^[a-f\d]{24}$/i),
    countedStock: z.coerce.number().int().min(0).max(10_000_000),
  })).min(1).max(500),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  value.lines.forEach((line, index) => {
    if (seen.has(line.productId)) {
      context.addIssue({ code: "custom", path: ["lines", index, "productId"], message: "Each product can only be counted once." });
    }
    seen.add(line.productId);
  });
});

export function stocktakeDifference(bookStock: number, countedStock: number) {
  return Math.trunc(countedStock) - Math.trunc(bookStock);
}
