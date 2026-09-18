import { z } from "zod";
import { accountingPeriodKeySchema, periodKeyFromDateKey, shiftAccountingPeriod } from "@/lib/accounting-periods";
import { isValidDateKey } from "@/lib/dates";
import { currencyFractionDigits, currencyMinorUnits, roundCurrency } from "@/lib/international";

const dateKeySchema = z.string().refine(isValidDateKey, "Choose a valid calendar date.");
const accountCodeSchema = z.string().trim().min(3).max(20);

export const fixedAssetInputSchema = z.object({
  clientRequestId: z.string().uuid(),
  acquisitionMode: z.enum(["CASH_PURCHASE", "REGISTER_ONLY"]),
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(60),
  serialNo: z.string().trim().max(80).default(""),
  location: z.string().trim().max(100).default(""),
  custodian: z.string().trim().max(100).default(""),
  purchaseDate: dateKeySchema,
  inServiceDate: dateKeySchema,
  cost: z.coerce.number().positive().max(1_000_000_000),
  residualValue: z.coerce.number().min(0).max(1_000_000_000).default(0),
  usefulLifeMonths: z.coerce.number().int().min(1).max(600),
  openingAccumulatedDepreciation: z.coerce.number().min(0).max(1_000_000_000).default(0),
  openingThroughPeriod: z.union([accountingPeriodKeySchema, z.literal("")]).default(""),
  assetAccountCode: accountCodeSchema.default("1500"),
  accumulatedDepreciationAccountCode: accountCodeSchema.default("1510"),
  depreciationExpenseAccountCode: accountCodeSchema.default("6300"),
  gainAccountCode: accountCodeSchema.default("4300"),
  lossAccountCode: accountCodeSchema.default("6400"),
  paymentAccountCode: z.string().trim().max(20).default(""),
  supplierReference: z.string().trim().max(100).default(""),
  notes: z.string().trim().max(500).default(""),
}).superRefine((value, context) => {
  if (value.inServiceDate < value.purchaseDate) context.addIssue({ code: "custom", path: ["inServiceDate"], message: "The in-service date cannot be before the purchase date." });
  if (value.residualValue >= value.cost) context.addIssue({ code: "custom", path: ["residualValue"], message: "Residual value must be lower than asset cost." });
  if (value.assetAccountCode === value.accumulatedDepreciationAccountCode) context.addIssue({ code: "custom", path: ["accumulatedDepreciationAccountCode"], message: "Asset cost and accumulated depreciation need different ledger accounts." });
  if (value.openingAccumulatedDepreciation > value.cost - value.residualValue) context.addIssue({ code: "custom", path: ["openingAccumulatedDepreciation"], message: "Opening depreciation cannot exceed the depreciable amount." });
  if (value.acquisitionMode === "CASH_PURCHASE" && !value.paymentAccountCode) context.addIssue({ code: "custom", path: ["paymentAccountCode"], message: "Choose the cash or bank account used for this purchase." });
  if (value.acquisitionMode === "CASH_PURCHASE" && value.openingAccumulatedDepreciation) context.addIssue({ code: "custom", path: ["openingAccumulatedDepreciation"], message: "A new cash purchase cannot start with accumulated depreciation." });
  if (value.acquisitionMode === "CASH_PURCHASE" && value.openingThroughPeriod) context.addIssue({ code: "custom", path: ["openingThroughPeriod"], message: "A new cash purchase cannot mark earlier depreciation as complete." });
  if (value.openingAccumulatedDepreciation > 0 && !value.openingThroughPeriod) context.addIssue({ code: "custom", path: ["openingThroughPeriod"], message: "State the month covered by the opening depreciation balance." });
  if (value.openingThroughPeriod && value.openingThroughPeriod < periodKeyFromDateKey(value.inServiceDate)) context.addIssue({ code: "custom", path: ["openingThroughPeriod"], message: "Opening coverage cannot end before the in-service month." });
  if (value.openingThroughPeriod && fixedAssetPeriodIndex(value.inServiceDate, value.openingThroughPeriod) >= value.usefulLifeMonths - 1
    && value.openingAccumulatedDepreciation < value.cost - value.residualValue) {
    context.addIssue({ code: "custom", path: ["openingAccumulatedDepreciation"], message: "An asset covered through the end of its useful life must be fully depreciated to its residual value." });
  }
});

export const fixedAssetActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("RUN_DEPRECIATION"),
    periodKey: accountingPeriodKeySchema,
    note: z.string().trim().min(3).max(300),
    clientRequestId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("DISPOSE"),
    id: z.string().length(24),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
    disposalDate: dateKeySchema,
    proceeds: z.coerce.number().min(0).max(1_000_000_000),
    proceedsAccountCode: z.string().trim().max(20).default(""),
    reference: z.string().trim().max(100).default(""),
    note: z.string().trim().min(3).max(300),
    clientRequestId: z.string().uuid(),
  }).superRefine((value, context) => {
    if (value.proceeds > 0 && !value.proceedsAccountCode) context.addIssue({ code: "custom", path: ["proceedsAccountCode"], message: "Choose the account receiving the disposal proceeds." });
  }),
]);

export class FixedAssetError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export type DepreciableAsset = {
  cost: unknown;
  residualValue: unknown;
  usefulLifeMonths: unknown;
  accumulatedDepreciation?: unknown;
  inServiceDate: string | Date;
  lastDepreciationPeriod?: unknown;
  openingThroughPeriod?: unknown;
  status?: unknown;
  disposalPeriod?: unknown;
};

export function fixedAssetPeriodIndex(inServiceDate: string | Date, periodKey: string) {
  const serviceKey = periodKeyFromDateKey(dateKey(inServiceDate));
  accountingPeriodKeySchema.parse(periodKey);
  const [startYear, startMonth] = serviceKey.split("-").map(Number);
  const [endYear, endMonth] = periodKey.split("-").map(Number);
  return (endYear - startYear) * 12 + endMonth - startMonth;
}

export function scheduledDepreciationAmount(asset: DepreciableAsset, periodKey: string, currency: string) {
  const index = fixedAssetPeriodIndex(asset.inServiceDate, periodKey);
  const life = Math.max(1, Math.trunc(Number(asset.usefulLifeMonths) || 0));
  if (index < 0 || index >= life) return 0;
  const depreciableUnits = Math.max(0, currencyMinorUnits(asset.cost, currency) - currencyMinorUnits(asset.residualValue, currency));
  const quotient = Math.floor(depreciableUnits / life);
  const remainder = depreciableUnits % life;
  const periodUnits = quotient + (index < remainder ? 1 : 0);
  return periodUnits / (10 ** currencyFractionDigits(currency));
}

export function nextFixedAssetDepreciationPeriod(asset: DepreciableAsset) {
  const servicePeriod = periodKeyFromDateKey(dateKey(asset.inServiceDate));
  const covered = String(asset.lastDepreciationPeriod || asset.openingThroughPeriod || "");
  return covered ? shiftAccountingPeriod(covered, 1) : servicePeriod;
}

export function fixedAssetDepreciationDue(asset: DepreciableAsset, throughPeriod: string, currency: string) {
  accountingPeriodKeySchema.parse(throughPeriod);
  if (String(asset.status) === "DISPOSED" && String(asset.disposalPeriod || "") < throughPeriod) return false;
  const remaining = Math.max(0, currencyMinorUnits(asset.cost, currency) - currencyMinorUnits(asset.residualValue, currency) - currencyMinorUnits(asset.accumulatedDepreciation, currency));
  if (!remaining) return false;
  const next = nextFixedAssetDepreciationPeriod(asset);
  return next <= throughPeriod && fixedAssetPeriodIndex(asset.inServiceDate, next) < Math.max(1, Math.trunc(Number(asset.usefulLifeMonths) || 0));
}

export function depreciationPostingAmount(asset: DepreciableAsset, periodKey: string, currency: string) {
  const index = fixedAssetPeriodIndex(asset.inServiceDate, periodKey);
  const remainingMonths = Math.max(0, Math.trunc(Number(asset.usefulLifeMonths) || 0) - index);
  if (!remainingMonths) return 0;
  const remaining = Math.max(0, currencyMinorUnits(asset.cost, currency) - currencyMinorUnits(asset.residualValue, currency) - currencyMinorUnits(asset.accumulatedDepreciation, currency));
  const periodUnits = Math.ceil(remaining / remainingMonths);
  return roundCurrency(Math.min(periodUnits, remaining) / (10 ** currencyFractionDigits(currency)), currency);
}

export function fixedAssetDisposalAmounts(asset: DepreciableAsset, proceedsValue: unknown, currency: string) {
  const cost = roundCurrency(asset.cost, currency);
  const accumulatedDepreciation = roundCurrency(asset.accumulatedDepreciation, currency);
  const proceeds = roundCurrency(proceedsValue, currency);
  const netBookValue = roundCurrency(cost - accumulatedDepreciation, currency);
  const differenceUnits = currencyMinorUnits(proceeds, currency) - currencyMinorUnits(netBookValue, currency);
  const scale = 10 ** currencyFractionDigits(currency);
  return {
    cost, accumulatedDepreciation, netBookValue, proceeds,
    gain: roundCurrency(Math.max(0, differenceUnits) / scale, currency),
    loss: roundCurrency(Math.max(0, -differenceUnits) / scale, currency),
  };
}

export function assertFixedAssetVersion(updatedAt: unknown, expectedUpdatedAt: string) {
  const current = updatedAt instanceof Date ? updatedAt.getTime() : new Date(String(updatedAt)).getTime();
  const expected = new Date(expectedUpdatedAt).getTime();
  if (!Number.isFinite(current) || !Number.isFinite(expected) || current !== expected) throw new FixedAssetError("This asset changed in another session. Refresh before trying again.");
}

export function nextFixedAssetUpdatedAt(previous: unknown, now = new Date()) {
  const old = previous instanceof Date ? previous.getTime() : new Date(String(previous)).getTime();
  return new Date(Math.max(now.getTime(), Number.isFinite(old) ? old + 1 : 0));
}

function dateKey(value: string | Date) {
  const key = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  if (!isValidDateKey(key)) throw new FixedAssetError("Choose a valid asset date.", 422);
  return key;
}
