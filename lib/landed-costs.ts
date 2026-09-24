import { z } from "zod";
import { currencyFractionDigits, currencyMinorUnits } from "@/lib/international";
import { allocateMinorUnits } from "@/lib/minor-unit-allocation";

export const landedCostInputSchema = z.object({
  receiptId: z.string().regex(/^[a-fA-F0-9]{24}$/),
  clientRequestId: z.string().uuid(),
  supplierId: z.string().regex(/^[a-fA-F0-9]{24}$/),
  supplierInvoiceNo: z.string().trim().min(2).max(80),
  invoiceDate: z.coerce.date(),
  postedAt: z.coerce.date(),
  total: z.coerce.number().positive().max(100_000_000),
  tax: z.coerce.number().min(0).max(100_000_000),
  category: z.enum(["FREIGHT", "DUTY", "INSURANCE", "HANDLING", "OTHER"]),
  allocationBasis: z.enum(["VALUE", "QUANTITY"]),
  description: z.string().trim().min(3).max(300),
}).superRefine((value, context) => {
  if (value.tax > value.total) context.addIssue({
    code: "custom",
    path: ["tax"],
    message: "Tax cannot exceed the landed-cost invoice total.",
  });
});

export function allocateLandedCost(input: {
  amount: number;
  currency: string;
  basis: "VALUE" | "QUANTITY";
  lines: Array<{
    productId: string;
    quantity: number;
    returnedQuantity?: number;
    baseInventoryValue: number;
    currentStock: number;
    retainedStock?: number;
  }>;
}) {
  const scale = 10 ** currencyFractionDigits(input.currency);
  const amountMinor = currencyMinorUnits(input.amount, input.currency);
  if (amountMinor <= 0) throw new Error("Landed cost must be positive at the accounting currency precision.");
  const weights = input.lines.map((line) => input.basis === "QUANTITY"
    ? Math.max(0, Number(line.quantity || 0))
    : Math.max(0, currencyMinorUnits(line.baseInventoryValue, input.currency)));
  const parts = allocateMinorUnits(amountMinor, weights, "The landed cost cannot be allocated across this receipt.");
  return input.lines.map((line, index) => {
    const quantity = Math.max(0, Number(line.quantity || 0));
    const returnedQuantity = Math.min(quantity, Math.max(0, Number(line.returnedQuantity || 0)));
    const retainedQuantity = Math.min(
      quantity - returnedQuantity,
      Math.max(0, Number(line.retainedStock ?? line.currentStock ?? 0)),
    );
    const allocatedMinor = parts[index];
    const targetInventoryMinor = quantity ? Math.round(allocatedMinor * retainedQuantity / quantity) : 0;
    const unitCostIncreaseMinor = line.currentStock > 0
      ? Math.floor(targetInventoryMinor / line.currentStock)
      : 0;
    const inventoryMinor = unitCostIncreaseMinor * line.currentStock;
    return {
      ...line,
      allocatedAmount: allocatedMinor / scale,
      retainedQuantity,
      inventoryAmount: inventoryMinor / scale,
      expenseAmount: (allocatedMinor - inventoryMinor) / scale,
      unitCostIncrease: unitCostIncreaseMinor / scale,
    };
  });
}
