import { z } from "zod";
import { countryCodeSchema, countryProfile, currencyCodeSchema, localeSchema, timeZoneSchema } from "@/lib/international";

export const regionalSettingsSchema = z.object({
  countryCode: countryCodeSchema,
  currency: currencyCodeSchema,
  locale: localeSchema,
  timeZone: timeZoneSchema,
  acceptedCurrencies: z.array(currencyCodeSchema).min(1).max(16),
  taxName: z.string().trim().min(2).max(20),
  taxRate: z.coerce.number().min(0).max(100),
  taxMode: z.enum(["EXCLUSIVE", "INCLUSIVE"]),
});

export type RegionalSettings = z.infer<typeof regionalSettingsSchema>;

export const EMPTY_REGIONAL_SETTINGS: RegionalSettings = {
  countryCode: "", currency: "", locale: "en", timeZone: "UTC", acceptedCurrencies: [],
  taxName: "Tax", taxRate: 0, taxMode: "EXCLUSIVE",
};

export function chooseRegionalCountry(current: RegionalSettings, countryCode: string, currencyLocked: boolean): RegionalSettings {
  const suggested = countryProfile(countryCode);
  const currency = currencyLocked ? current.currency : suggested.currency;
  return {
    ...current, countryCode, currency, locale: suggested.locale, timeZone: suggested.timeZone,
    acceptedCurrencies: currencyLocked ? [...new Set([currency, ...current.acceptedCurrencies])] : currency ? [currency] : [],
    taxName: suggested.taxName, taxRate: 0,
  };
}

export const LEDGER_CURRENCY_MESSAGE = "The accounting currency is fixed when the ledger is created. You can change the main country, time zone and settlement currencies without relabelling historical amounts. A different accounting currency requires a separately configured ledger or a reviewed migration.";

export function ledgerCurrencyChangeError(current: string, next: string) {
  return current === next ? null : LEDGER_CURRENCY_MESSAGE;
}
