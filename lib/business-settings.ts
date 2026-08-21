import { countryProfile, isValidCurrency, isValidLocale, isValidTimeZone, type CountryCode, type OrganizationType } from "@/lib/international";

export type BusinessSettings = {
  key: "business";
  businessName: string;
  legalEntityName: string;
  registrationNo: string;
  email: string;
  phone: string;
  address: string;
  countryCode: CountryCode;
  timeZone: string;
  locale: string;
  currency: string;
  acceptedCurrencies: string[];
  taxName: string;
  taxRate: number;
  taxMode: "EXCLUSIVE" | "INCLUSIVE";
  pointsPerDollar: number;
  lowStockNotifications: boolean;
  organizationType: OrganizationType;
  franchiseBrand: string;
  franchiseCode: string;
  parentOrganizationCode: string;
  updatedAt?: string | Date;
};

export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  key: "business",
  businessName: "Kōn-Kōn Matchā",
  legalEntityName: "",
  registrationNo: "",
  email: "",
  phone: "",
  address: "",
  countryCode: "SG",
  timeZone: "Asia/Singapore",
  locale: "en-SG",
  currency: "SGD",
  acceptedCurrencies: ["SGD", "MYR", "CNY", "USD"],
  taxName: "GST",
  taxRate: 0,
  taxMode: "EXCLUSIVE",
  pointsPerDollar: 1,
  lowStockNotifications: true,
  organizationType: "INDEPENDENT",
  franchiseBrand: "",
  franchiseCode: "",
  parentOrganizationCode: "",
};

export function normaliseBusinessSettings(value?: Record<string, unknown> | null): BusinessSettings {
  const profile = countryProfile(String(value?.countryCode || DEFAULT_BUSINESS_SETTINGS.countryCode));
  const currency = isValidCurrency(String(value?.currency || "")) ? String(value?.currency) : profile.currency;
  const accepted = Array.isArray(value?.acceptedCurrencies)
    ? [...new Set(value.acceptedCurrencies.map(String).filter(isValidCurrency))]
    : DEFAULT_BUSINESS_SETTINGS.acceptedCurrencies;
  return {
    ...DEFAULT_BUSINESS_SETTINGS,
    ...value,
    key: "business",
    businessName: String(value?.businessName || DEFAULT_BUSINESS_SETTINGS.businessName),
    legalEntityName: String(value?.legalEntityName || ""),
    registrationNo: String(value?.registrationNo || ""),
    email: String(value?.email || ""),
    phone: String(value?.phone || ""),
    address: String(value?.address || ""),
    countryCode: profile.code,
    timeZone: isValidTimeZone(String(value?.timeZone || "")) ? String(value?.timeZone) : profile.timeZone,
    locale: isValidLocale(String(value?.locale || "")) ? String(value?.locale) : profile.locale,
    currency,
    acceptedCurrencies: [...new Set([currency, ...accepted])],
    taxName: String(value?.taxName || profile.taxName),
    taxRate: Number(value?.taxRate || 0),
    taxMode: value?.taxMode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE",
    pointsPerDollar: Number(value?.pointsPerDollar ?? 1),
    lowStockNotifications: value?.lowStockNotifications !== false,
    organizationType: ["FRANCHISOR", "FRANCHISEE", "CORPORATE_GROUP"].includes(String(value?.organizationType))
      ? value?.organizationType as OrganizationType
      : "INDEPENDENT",
    franchiseBrand: String(value?.franchiseBrand || ""),
    franchiseCode: String(value?.franchiseCode || ""),
    parentOrganizationCode: String(value?.parentOrganizationCode || ""),
  };
}
