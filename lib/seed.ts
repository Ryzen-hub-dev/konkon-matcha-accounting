import type { ClientSession, Db } from "mongodb";
import { ensureDefaultInvoiceTemplate } from "@/lib/invoice-templates";
import { ensureDefaultReceiptTemplate } from "@/lib/receipt-templates";
import { ensureDefaultPaymentMethods } from "@/lib/payment-methods";
import { DEFAULT_BUSINESS_SETTINGS } from "@/lib/business-settings";

const starterProducts = [
  { sku: "MATCHA-A-30", name: "Gurēdo A Ceremonial · 30g", category: "Matcha powder", unit: "tin", price: 46.9, cost: 24, stock: 18, reorderLevel: 6 },
  { sku: "MATCHA-E-30", name: "Gurēdo E Culinary · 30g", category: "Matcha powder", unit: "tin", price: 12.9, cost: 6.2, stock: 32, reorderLevel: 10 },
  { sku: "HOJICHA-H-30", name: "Gurēdo H Hojicha · 30g", category: "Hojicha", unit: "pouch", price: 20.9, cost: 10.5, stock: 14, reorderLevel: 5 },
  { sku: "DOGU-CHASEN", name: "Purple Bamboo Chasen", category: "Dōgu", unit: "piece", price: 18.9, cost: 8.5, stock: 12, reorderLevel: 4 },
  { sku: "SNACK-POPCORN", name: "Matcha Popcorn", category: "Pantry", unit: "bag", price: 9.9, cost: 4.1, stock: 24, reorderLevel: 8 },
];

const chartOfAccounts = [
  ["1000", "Cash on hand", "ASSET"], ["1010", "Bank", "ASSET"],
  ["1200", "Inventory", "ASSET"], ["2000", "Accounts payable", "LIABILITY"],
  ["2100", "GST payable", "LIABILITY"],
  ["3000", "Owner's equity", "EQUITY"], ["4000", "Product sales", "REVENUE"],
  ["5000", "Cost of goods sold", "EXPENSE"], ["6100", "Operating expenses", "EXPENSE"],
];

export async function seedWorkspace(db: Db, ownerId: unknown, businessName: string, seedProducts: boolean, session?: ClientSession) {
  const now = new Date();
  await db.collection("systemControls").updateOne(
    { _id: "workspace" as never },
    { $setOnInsert: { mode: "OPEN", reason: "", reopenAt: null, scannerGeneration: 1, createdAt: now, updatedAt: now } },
    { upsert: true, ...(session ? { session } : {}) },
  );
  await db.collection("settings").updateOne(
    { key: "business" },
    { $setOnInsert: { ...DEFAULT_BUSINESS_SETTINGS, businessName, createdAt: now }, $set: { updatedAt: now } },
    { upsert: true, ...(session ? { session } : {}) },
  );
  await db.collection("locations").updateOne(
    { systemKey: "HEADQUARTERS" },
    { $setOnInsert: { code: "HQ", name: `${businessName} HQ`, type: "HEADQUARTERS", countryCode: "SG", timeZone: "Asia/Singapore", locale: "en-SG", currency: "SGD", address: "", active: true, systemKey: "HEADQUARTERS", createdBy: ownerId, createdAt: now, updatedAt: now } },
    { upsert: true, ...(session ? { session } : {}) },
  );
  await db.collection("chartOfAccounts").bulkWrite(chartOfAccounts.map(([code, name, type]) => ({
    updateOne: { filter: { code }, update: { $setOnInsert: { code, name, type, active: true, createdAt: now } }, upsert: true },
  })), session ? { session } : undefined);
  await ensureDefaultInvoiceTemplate(db, ownerId, session);
  await ensureDefaultReceiptTemplate(db, ownerId, session);
  await ensureDefaultPaymentMethods(db, ownerId, session);
  if (seedProducts) {
    await db.collection("products").bulkWrite(starterProducts.map((product) => ({
      updateOne: {
        filter: { sku: product.sku },
        update: { $setOnInsert: { ...product, active: true, createdAt: now, updatedAt: now, createdBy: ownerId } },
        upsert: true,
      },
    })), session ? { session } : undefined);
  }
}
