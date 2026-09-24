import { applyDimensionAllocation, type ResolvedDimensionAllocation } from "@/lib/dimension-allocation";
import { applyDocumentDimensions, type DocumentDimensionSelection } from "@/lib/dimension-selection";
import { currencyFractionDigits, currencyMinorUnits } from "@/lib/international";
import { allocateMinorUnits, sliceMinorUnits } from "@/lib/minor-unit-allocation";

type SaleFinancialItem = {
  quantity: number;
  lineTotal: number;
  lineCost: number;
};

export type ClassifiedPosItem = {
  productId?: unknown;
  sku?: string;
  name: string;
  lineNetSales: number;
  lineTax: number;
  lineGross: number;
  lineCost: number;
  dimensionSelection?: DocumentDimensionSelection;
};

export type BuiltPosJournalLine = {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  productId?: unknown;
  productSku?: string;
  productName?: string;
  costCentre?: { code: string; name: string; id: unknown };
  project?: { code: string; name: string; id: unknown };
  dimensionSource?: { type: string; mode: string };
  dimensionRule?: { source: string; matchKey: string; id: unknown; version: number };
  dimensionSplit?: { percentage: number; index: number; count: number };
};

export function allocateSaleItemFinancials<T extends SaleFinancialItem>(
  items: T[],
  totals: { discount: number; netSales: number; tax: number; total: number; taxMode?: "INCLUSIVE" | "EXCLUSIVE" },
  currency: string,
) {
  if (!items.length) throw new Error("A POS sale needs at least one item.");
  const scale = 10 ** currencyFractionDigits(currency);
  const subtotalWeights = items.map(item => currencyMinorUnits(item.lineTotal, currency));
  const discounts = allocateMinorUnits(currencyMinorUnits(totals.discount, currency), subtotalWeights, "POS amounts exceed the safe accounting range.");
  const discountedWeights = subtotalWeights.map((amount, index) => Math.max(0, amount - discounts[index]));
  const inclusive = totals.taxMode === "INCLUSIVE";
  const gross = inclusive ? discountedWeights : null;
  const nets = inclusive
    ? []
    : allocateMinorUnits(currencyMinorUnits(totals.netSales, currency), discountedWeights, "POS amounts exceed the safe accounting range.");
  const taxes = allocateMinorUnits(currencyMinorUnits(totals.tax, currency), inclusive ? gross! : nets, "POS amounts exceed the safe accounting range.");
  const resolvedNets = inclusive ? gross!.map((amount, index) => amount - taxes[index]) : nets;
  const resolvedGross = inclusive ? gross! : resolvedNets.map((amount, index) => amount + taxes[index]);
  const grossTarget = currencyMinorUnits(totals.total, currency);
  if (resolvedNets.reduce((sum, value) => sum + value, 0) !== currencyMinorUnits(totals.netSales, currency)
    || resolvedGross.reduce((sum, value) => sum + value, 0) !== grossTarget) {
    throw new Error("POS net sales and tax do not reconcile to the payment total.");
  }
  return items.map((item, index) => ({
    ...item,
    lineDiscount: discounts[index] / scale,
    lineNetSales: resolvedNets[index] / scale,
    lineTax: taxes[index] / scale,
    lineGross: resolvedGross[index] / scale,
  }));
}

export function sliceRefundItemFinancials(
  item: SaleFinancialItem & { lineDiscount?: unknown; lineNetSales?: unknown; lineTax?: unknown; lineGross?: unknown },
  refundedQuantity: number,
  refundQuantity: number,
  currency: string,
  taxMode: "INCLUSIVE" | "EXCLUSIVE" = "EXCLUSIVE",
) {
  if (![item.lineDiscount, item.lineNetSales, item.lineTax, item.lineGross].every(value => typeof value === "number" && Number.isFinite(value))) return null;
  const scale = 10 ** currencyFractionDigits(currency);
  const sliceUnits = (value: unknown) => sliceMinorUnits(currencyMinorUnits(value, currency), item.quantity, refundedQuantity, refundQuantity, "POS refund amounts cannot be reconciled.");
  const lineSubtotal = sliceUnits(item.lineTotal);
  const lineTax = sliceUnits(item.lineTax);
  const lineNetSales = taxMode === "INCLUSIVE" ? lineSubtotal - sliceUnits(item.lineDiscount) - lineTax : sliceUnits(item.lineNetSales);
  const lineGross = lineNetSales + lineTax;
  const lineDiscount = lineSubtotal - (taxMode === "INCLUSIVE" ? lineGross : lineNetSales);
  return { lineSubtotal: lineSubtotal / scale, lineDiscount: lineDiscount / scale, lineNetSales: lineNetSales / scale, lineTax: lineTax / scale, lineGross: lineGross / scale, lineCost: sliceUnits(item.lineCost) / scale };
}

function classifyLines<T extends Record<string, unknown>>(
  lines: T[],
  selection: DocumentDimensionSelection | null | undefined,
  fallback: ResolvedDimensionAllocation | null | undefined,
  currency: string,
) {
  return selection ? applyDocumentDimensions(lines, selection) : applyDimensionAllocation(lines, fallback, currency);
}

export function buildClassifiedPosJournalLines(input: {
  kind: "SALE" | "REFUND";
  currency: string;
  total: number;
  tax: number;
  paymentAccount: { code: string; name: string };
  items: ClassifiedPosItem[];
  fallbackAllocation?: ResolvedDimensionAllocation | null;
}) {
  const sale = input.kind === "SALE";
  const paymentLines = classifyLines([{
    accountCode: input.paymentAccount.code,
    accountName: input.paymentAccount.name,
    debit: sale ? input.total : 0,
    credit: sale ? 0 : input.total,
  }], null, input.fallbackAllocation, input.currency);
  const taxLines = input.tax > 0 ? classifyLines([{
    accountCode: "2100",
    accountName: "Tax payable",
    debit: sale ? 0 : input.tax,
    credit: sale ? input.tax : 0,
  }], null, input.fallbackAllocation, input.currency) : [];
  const itemLines = input.items.flatMap(item => classifyLines([
    ...(item.lineNetSales > 0 ? [{
      accountCode: "4000", accountName: "Product sales", debit: sale ? 0 : item.lineNetSales, credit: sale ? item.lineNetSales : 0,
      productId: item.productId, productSku: item.sku || "", productName: item.name,
    }] : []),
    ...(item.lineCost > 0 ? [
      { accountCode: "5000", accountName: "Cost of goods sold", debit: sale ? item.lineCost : 0, credit: sale ? 0 : item.lineCost, productId: item.productId, productSku: item.sku || "", productName: item.name },
      { accountCode: "1200", accountName: "Inventory", debit: sale ? 0 : item.lineCost, credit: sale ? item.lineCost : 0, productId: item.productId, productSku: item.sku || "", productName: item.name },
    ] : []),
  ], item.dimensionSelection, input.fallbackAllocation, input.currency));
  return [...paymentLines, ...itemLines, ...taxLines] as BuiltPosJournalLine[];
}
