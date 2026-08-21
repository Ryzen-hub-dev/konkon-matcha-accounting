import { z } from "zod";

export const COUNTRY_PROFILES = [
  { code: "SG", name: "Singapore", locale: "en-SG", currency: "SGD", timeZone: "Asia/Singapore", taxName: "GST" },
  { code: "MY", name: "Malaysia", locale: "en-MY", currency: "MYR", timeZone: "Asia/Kuala_Lumpur", taxName: "SST" },
  { code: "CN", name: "Mainland China", locale: "zh-CN", currency: "CNY", timeZone: "Asia/Shanghai", taxName: "VAT" },
  { code: "HK", name: "Hong Kong", locale: "zh-HK", currency: "HKD", timeZone: "Asia/Hong_Kong", taxName: "Tax" },
  { code: "ID", name: "Indonesia", locale: "id-ID", currency: "IDR", timeZone: "Asia/Jakarta", taxName: "PPN" },
  { code: "TH", name: "Thailand", locale: "th-TH", currency: "THB", timeZone: "Asia/Bangkok", taxName: "VAT" },
  { code: "VN", name: "Vietnam", locale: "vi-VN", currency: "VND", timeZone: "Asia/Ho_Chi_Minh", taxName: "VAT" },
  { code: "PH", name: "Philippines", locale: "en-PH", currency: "PHP", timeZone: "Asia/Manila", taxName: "VAT" },
  { code: "JP", name: "Japan", locale: "ja-JP", currency: "JPY", timeZone: "Asia/Tokyo", taxName: "Consumption tax" },
  { code: "AU", name: "Australia", locale: "en-AU", currency: "AUD", timeZone: "Australia/Sydney", taxName: "GST" },
  { code: "GB", name: "United Kingdom", locale: "en-GB", currency: "GBP", timeZone: "Europe/London", taxName: "VAT" },
  { code: "US", name: "United States", locale: "en-US", currency: "USD", timeZone: "America/New_York", taxName: "Sales tax" },
] as const;

export const CURRENCY_OPTIONS = [
  "SGD", "MYR", "CNY", "HKD", "USD", "EUR", "GBP", "JPY", "AUD", "NZD",
  "IDR", "THB", "VND", "PHP", "TWD", "KRW", "INR", "AED", "SAR", "CAD",
  "CHF", "BND", "MOP", "KWD", "BHD", "OMR",
] as const;

export const ORGANIZATION_TYPES = ["INDEPENDENT", "FRANCHISOR", "FRANCHISEE", "CORPORATE_GROUP"] as const;

export type CountryCode = (typeof COUNTRY_PROFILES)[number]["code"];
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

export const countryCodeSchema = z.enum(COUNTRY_PROFILES.map((profile) => profile.code) as [CountryCode, ...CountryCode[]]);

export function isValidCurrency(value: string) {
  if (!/^[A-Z]{3}$/.test(value)) return false;
  try {
    if (typeof Intl.supportedValuesOf === "function" && !Intl.supportedValuesOf("currency").includes(value)) return false;
    new Intl.NumberFormat("en", { style: "currency", currency: value }).format(1);
    return true;
  } catch {
    return false;
  }
}

export function isValidTimeZone(value: string) {
  if (!value || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function isValidLocale(value: string) {
  if (!value || value.length > 35) return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

export const currencyCodeSchema = z.string().trim().toUpperCase().refine(isValidCurrency, "Use a valid ISO 4217 currency code.");
export const timeZoneSchema = z.string().trim().refine(isValidTimeZone, "Use a valid IANA time zone.");
export const localeSchema = z.string().trim().refine(isValidLocale, "Use a valid locale such as en-SG or zh-CN.");

export function countryProfile(code: string) {
  return COUNTRY_PROFILES.find((profile) => profile.code === code) || COUNTRY_PROFILES[0];
}

export function currencyFractionDigits(currency: string) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function roundCurrency(value: unknown, currency = "SGD") {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return 0;
  const scale = 10 ** currencyFractionDigits(currency);
  return Math.round((amount + Number.EPSILON) * scale) / scale;
}

export function normaliseExchangeRate(value: unknown) {
  const rate = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000_000) return 0;
  return Math.round((rate + Number.EPSILON) * 100_000_000) / 100_000_000;
}

export function convertCurrency(amount: unknown, quotePerBase: unknown, quoteCurrency: string) {
  const rate = normaliseExchangeRate(quotePerBase);
  if (!rate) return 0;
  return roundCurrency(Number(amount) * rate, quoteCurrency);
}

export function currencyMinorUnits(value: unknown, currency: string) {
  const scale = 10 ** currencyFractionDigits(currency);
  return Math.round(roundCurrency(value, currency) * scale);
}
