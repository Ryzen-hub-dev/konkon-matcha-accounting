"use client";

import { createContext, useContext, useMemo } from "react";
import type { BusinessSettings } from "@/lib/business-settings";
import { DEFAULT_BUSINESS_SETTINGS } from "@/lib/business-settings";

type BusinessFormat = {
  profile: BusinessSettings;
  money: Intl.NumberFormat;
  shortDate: Intl.DateTimeFormat;
  dateTime: Intl.DateTimeFormat;
};

const defaultValue: BusinessFormat = {
  profile: DEFAULT_BUSINESS_SETTINGS,
  money: new Intl.NumberFormat("en-SG", { style: "currency", currency: "SGD" }),
  shortDate: new Intl.DateTimeFormat("en-SG", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Singapore" }),
  dateTime: new Intl.DateTimeFormat("en-SG", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" }),
};

const BusinessContext = createContext(defaultValue);

export function BusinessProvider({ profile, children }: { profile: BusinessSettings; children: React.ReactNode }) {
  const value = useMemo<BusinessFormat>(() => ({
    profile,
    money: new Intl.NumberFormat(profile.locale, { style: "currency", currency: profile.currency }),
    shortDate: new Intl.DateTimeFormat(profile.locale, { day: "2-digit", month: "short", year: "numeric", timeZone: profile.timeZone }),
    dateTime: new Intl.DateTimeFormat(profile.locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: profile.timeZone }),
  }), [profile]);
  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
}
export function useBusiness() {
  return useContext(BusinessContext);
}
