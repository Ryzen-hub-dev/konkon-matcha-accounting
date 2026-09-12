import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import { COUNTRY_PROFILES, countryCodeSchema, countryProfile, isValidCurrency, isValidLocale, isValidTimeZone, roundCurrency } from "../lib/international";
import { normaliseBusinessSettings } from "../lib/business-settings";
import { businessPeriodKeys, dateKeyInTimeZone, formatCalendarDate, isValidDateKey, journalReportDateExpression } from "../lib/dates";
import { chooseRegionalCountry, EMPTY_REGIONAL_SETTINGS, ledgerCurrencyChangeError, regionalSettingsSchema } from "../lib/regional-settings";
import { invoicePreview, receiptPreview } from "../lib/document-preview";
import { prepareJournalAmounts } from "../lib/journals";
import { computeCouponDiscount, couponInputSchema, couponUpdateSchema, validateCouponAmounts } from "../lib/coupons";
import { seedWorkspace } from "../lib/seed";

test("regional catalogue covers 249 unique countries and validates its offline suggestions", () => {
  assert.equal(COUNTRY_PROFILES.length, 249);
  assert.equal(new Set(COUNTRY_PROFILES.map(country => country.code)).size, 249);
  for (const country of COUNTRY_PROFILES) {
    assert.equal(countryCodeSchema.safeParse(country.code).success, true, country.code);
    if (country.currency) assert.equal(isValidCurrency(country.currency), true, country.code);
    assert.equal(isValidLocale(country.locale), true, country.code);
    assert.equal(isValidTimeZone(country.timeZone), true, `${country.code}: ${country.timeZone}`);
  }
  assert.equal(countryProfile("AQ").currency, ""); // No invented national currency.
  assert.equal(countryProfile("ZZ").code, "ZZ");
  assert.notEqual(countryProfile("ZZ").timeZone, "Asia/Singapore");
  assert.equal(countryCodeSchema.safeParse("ZZ").success, false);
  assert.equal(countryCodeSchema.parse(" de "), "DE");
});

test("new workspaces have no preselected Singapore country and require a real currency", () => {
  assert.equal(EMPTY_REGIONAL_SETTINGS.countryCode, "");
  assert.equal(regionalSettingsSchema.safeParse(EMPTY_REGIONAL_SETTINGS).success, false);
  const malaysia = chooseRegionalCountry(EMPTY_REGIONAL_SETTINGS, "MY", false);
  assert.equal(malaysia.currency, "MYR");
  assert.equal(malaysia.timeZone, "Asia/Kuala_Lumpur");
  assert.equal(malaysia.taxName, "SST");
  assert.deepEqual(malaysia.acceptedCurrencies, ["MYR"]);
  assert.equal(regionalSettingsSchema.safeParse(malaysia).success, true);
  const germany = chooseRegionalCountry(malaysia, "DE", false);
  assert.equal(germany.currency, "EUR");
  assert.equal(germany.locale, "de-DE");
  assert.equal(germany.timeZone, "Europe/Berlin");
});

test("country changes preserve an existing ledger currency and reset tax for explicit review", () => {
  const current = { ...chooseRegionalCountry(EMPTY_REGIONAL_SETTINGS, "SG", false), taxRate: 9 };
  const moved = chooseRegionalCountry(current, "US", true);
  assert.equal(moved.countryCode, "US");
  assert.equal(moved.currency, "SGD");
  assert.equal(moved.taxRate, 0);
  assert.deepEqual(moved.acceptedCurrencies, ["SGD"]);
  assert.equal(ledgerCurrencyChangeError("SGD", "SGD"), null);
  assert.match(ledgerCurrencyChangeError("SGD", "USD")!, /historical amounts/);
});

test("settings normalization derives regional defaults without adding Singapore settlement currencies", () => {
  const profile = normaliseBusinessSettings({ countryCode: "DE" });
  assert.equal(profile.currency, "EUR");
  assert.equal(profile.timeZone, "Europe/Berlin");
  assert.deepEqual(profile.acceptedCurrencies, ["EUR"]);
  const custom = normaliseBusinessSettings({ countryCode: "US", timeZone: "America/Los_Angeles", locale: "es-US", currency: "USD" });
  assert.equal(custom.timeZone, "America/Los_Angeles");
  assert.equal(custom.locale, "es-US");
});

test("dashboard month and seven-day keys follow local dates across the UTC month boundary", () => {
  const now = new Date("2026-08-31T18:00:00Z");
  const asia = businessPeriodKeys(now, "Asia/Kuala_Lumpur");
  assert.equal(asia.today, "2026-09-01");
  assert.equal(asia.month, "2026-09-01");
  assert.equal(asia.days[0], "2026-08-26");
  const america = businessPeriodKeys(now, "America/Los_Angeles");
  assert.equal(america.today, "2026-08-31");
  assert.equal(america.month, "2026-08-01");
  assert.equal(america.days.length, 7);
});

test("local calendar keys handle DST and fractional UTC offsets", () => {
  assert.equal(dateKeyInTimeZone("2026-03-08T04:59:59Z", "America/New_York"), "2026-03-07");
  assert.equal(dateKeyInTimeZone("2026-03-08T07:01:00Z", "America/New_York"), "2026-03-08");
  assert.equal(dateKeyInTimeZone("2026-09-12T18:20:00Z", "Asia/Kathmandu"), "2026-09-13");
  assert.equal(businessPeriodKeys(new Date("2026-11-01T07:00:00Z"), "America/New_York").days.at(-1), "2026-11-01");
});

test("calendar due dates never shift backwards with display locale", () => {
  assert.equal(formatCalendarDate("2026-09-01T00:00:00Z", "en-US"), "Sep 01, 2026");
  assert.equal(formatCalendarDate(new Date("2026-09-01T00:00:00Z"), "de-DE"), "01. Sept. 2026");
  assert.equal(isValidDateKey("2026-02-30"), false);
  assert.equal(isValidDateKey("2026-99-01"), false);
  assert.equal(isValidDateKey("2028-02-29"), true);
  assert.deepEqual(journalReportDateExpression("America/New_York").$ifNull[0], "$businessDate");
});

test("manual journals balance exactly with zero and three decimal currencies", () => {
  const lines = (debit: number, credit: number) => [
    { accountCode: "1000", accountName: "Cash", debit, credit: 0 },
    { accountCode: "3000", accountName: "Equity", debit: 0, credit },
  ];
  assert.equal(prepareJournalAmounts(lines(100, 100), "JPY").totalDebit, 100);
  assert.equal(prepareJournalAmounts(lines(1.234, 1.234), "KWD").totalDebit, 1.234);
  assert.throws(() => prepareJournalAmounts(lines(1.234, 1.233), "KWD"), /balance/);
  assert.throws(() => prepareJournalAmounts(lines(1.1, 1.1), "JPY"), /precision/);
  assert.throws(() => prepareJournalAmounts(lines(0.001, 0.001), "JPY"), /positive/);
});

test("coupon discounts use the same currency precision as checkout", () => {
  assert.equal(computeCouponDiscount({ type: "PERCENT", value: 10, minSpend: 0 }, 105, "JPY"), 11);
  assert.equal(computeCouponDiscount({ type: "PERCENT", value: 10, minSpend: 0 }, 1.234, "KWD"), 0.123);
  assert.equal(computeCouponDiscount({ type: "FIXED", value: 0.123, minSpend: 0 }, 1.234, "KWD"), 0.123);
  assert.throws(() => validateCouponAmounts({ type: "FIXED", value: 0.1, minSpend: 0 }, "JPY"), /positive/);
  assert.throws(() => validateCouponAmounts({ type: "FIXED", value: 1, minSpend: 0.01 }, "JPY"), /precision/);
  assert.equal(validateCouponAmounts({ type: "FIXED", value: 0.123, minSpend: 1.234 }, "KWD").value, 0.123);
});

test("receipt and invoice previews use the active country profile, tax mode and precision", () => {
  for (const code of ["MY", "US", "DE", "JP", "KW"]) {
    const profile = normaliseBusinessSettings({ countryCode: code, businessName: "Sample local store", taxRate: 7, taxMode: "INCLUSIVE" });
    const receipt = receiptPreview(profile, new Date("2026-09-01T01:00:00Z"));
    const invoice = invoicePreview(profile, 14, new Date("2026-09-01T01:00:00Z"));
    assert.equal(receipt.businessSnapshot?.currency, profile.currency);
    assert.equal(invoice.businessSnapshot?.locale, profile.locale);
    assert.equal(receipt.total, roundCurrency(receipt.subtotal - receipt.discount, profile.currency));
    assert.equal(invoice.total, invoice.subtotal);
    assert.equal(invoice.taxRate, 7);
    assert.equal(receipt.changeDue, roundCurrency(Number(receipt.tenderedAmount) - receipt.total, profile.currency));
  }
});

test("partial coupon updates preserve omitted codes, limits and activation state", () => {
  const id = "1234567890abcdef12345678";
  const current = couponInputSchema.parse({ code: "SAVE10", name: "Member offer", type: "PERCENT", value: 10, minSpend: 2.345, usageLimit: 10, perMemberLimit: 2, active: false, startsAt: "2026-09-01", expiresAt: "2026-10-01" });
  assert.deepEqual(couponUpdateSchema.parse({ id, active: true }), { id, active: true });
  const { id: _id, ...fields } = couponUpdateSchema.parse({ id, startsAt: "2026-09-12" });
  assert.deepEqual(Object.keys(fields), ["startsAt"]);
  const changed = couponInputSchema.parse({ ...current, ...fields });
  assert.equal(changed.code, "SAVE10");
  assert.equal(changed.minSpend, 2.345);
  assert.equal(changed.usageLimit, 10);
  assert.equal(changed.perMemberLimit, 2);
  assert.equal(changed.active, false);
  assert.equal(changed.startsAt.toISOString(), "2026-09-12T00:00:00.000Z");
});

test("Owner setup seeds headquarters and products with selected region, without persisting account secrets", async () => {
  const writes: Array<{ name: string; payload: unknown }> = [];
  const db = { collection: (name: string) => ({
    updateOne: async (_filter: unknown, update: unknown) => { writes.push({ name, payload: update }); },
    updateMany: async (_filter: unknown, update: unknown) => { writes.push({ name, payload: update }); },
    bulkWrite: async (operations: unknown) => { writes.push({ name, payload: operations }); },
  }) } as unknown as Db;
  const region = { ...chooseRegionalCountry(EMPTY_REGIONAL_SETTINGS, "JP", false), password: "fake-secret-that-must-never-be-persisted" };
  await seedWorkspace(db, "test-owner", "Sample store", true, undefined, region);
  const saved = JSON.stringify(writes);
  assert.equal(saved.includes(region.password), false);
  const settings = writes.find(write => write.name === "settings")!.payload as { $setOnInsert: Record<string, unknown> };
  const headquarters = writes.find(write => write.name === "locations")!.payload as { $setOnInsert: Record<string, unknown> };
  assert.equal(settings.$setOnInsert.currency, "JPY");
  assert.equal(headquarters.$setOnInsert.countryCode, "JP");
  assert.equal(headquarters.$setOnInsert.timeZone, "Asia/Tokyo");
  assert.equal(saved.includes("SINGAPORE"), false);
});
