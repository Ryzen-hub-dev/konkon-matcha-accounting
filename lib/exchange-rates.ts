import type { Db } from "mongodb";
import { convertCurrency, normaliseExchangeRate } from "@/lib/international";

export async function readExchangeRate(db: Db, baseCurrency: string, quoteCurrency: string) {
  if (baseCurrency === quoteCurrency) return { rate: 1, source: "BASE", effectiveAt: new Date(0) };
  const record = await db.collection("exchangeRates").findOne({ baseCurrency, quoteCurrency, active: { $ne: false } });
  const rate = normaliseExchangeRate(record?.rate);
  return rate ? { rate, source: String(record?.source || "MANUAL"), effectiveAt: record?.effectiveAt || record?.updatedAt || null } : null;
}
export function quoteAmount(baseAmount: number, rate: number, quoteCurrency: string) {
  return convertCurrency(baseAmount, rate, quoteCurrency);
}
