import { z } from "zod";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb, getMongoClient } from "@/lib/db";
import { serialise } from "@/lib/format";
import { ledgerCurrencyChangeError } from "@/lib/regional-settings";
import {
  countryCodeSchema,
  currencyCodeSchema,
  localeSchema,
  ORGANIZATION_TYPES,
  timeZoneSchema,
} from "@/lib/international";

export const runtime = "nodejs";

const settingsSchema = z.object({
  businessName: z.string().trim().min(2).max(100),
  legalEntityName: z.string().trim().max(140).default(""),
  registrationNo: z.string().trim().max(60).default(""),
  email: z.union([z.string().trim().email(), z.literal("")]).default(""),
  phone: z.string().trim().max(30).default(""),
  address: z.string().trim().max(300).default(""),
  countryCode: countryCodeSchema,
  timeZone: timeZoneSchema,
  locale: localeSchema,
  currency: currencyCodeSchema,
  acceptedCurrencies: z.array(currencyCodeSchema).min(1).max(16),
  taxName: z.string().trim().min(2).max(20),
  taxRate: z.coerce.number().min(0).max(100),
  taxMode: z.enum(["EXCLUSIVE", "INCLUSIVE"]).default("EXCLUSIVE"),
  pointsPerDollar: z.coerce.number().min(0).max(100),
  lowStockNotifications: z.boolean().default(true),
  organizationType: z.enum(ORGANIZATION_TYPES).default("INDEPENDENT"),
  franchiseBrand: z.string().trim().max(100).default(""),
  franchiseCode: z.string().trim().toUpperCase().max(40).regex(/^$|^[A-Z0-9_-]+$/).default(""),
  parentOrganizationCode: z.string().trim().toUpperCase().max(40).regex(/^$|^[A-Z0-9_-]+$/).default(""),
  workspaceTheme: z.enum(["MATCHA", "PROFESSIONAL", "FOCUS"]).default("MATCHA"),
  workspaceLogoDataUrl: z.string().max(350_000).refine(
    (value) => value === "" || /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value),
    "Upload a PNG, JPEG or WebP logo under 250 KB.",
  ).optional(),
}).superRefine((value, context) => {
  if (!value.acceptedCurrencies.includes(value.currency)) {
    context.addIssue({ code: "custom", path: ["acceptedCurrencies"], message: "Accepted currencies must include the workspace base currency." });
  }
  if (value.organizationType === "FRANCHISEE" && (!value.franchiseBrand || !value.franchiseCode || !value.parentOrganizationCode)) {
    context.addIssue({ code: "custom", path: ["franchiseCode"], message: "Franchisees require a brand, location code and parent organization code." });
  }
});

class CurrencyChangeConflict extends Error {}
class ThemeChangeForbidden extends Error {}
class LogoChangeForbidden extends Error {}

function historySnapshot(settings: ReturnType<typeof normaliseBusinessSettings>) {
  const { workspaceLogoDataUrl, ...rest } = settings;
  return { ...rest, hasWorkspaceLogo: Boolean(workspaceLogoDataUrl) };
}

export async function GET() {
  const auth = await authorize("settings.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const settings = await db.collection("settings").findOne({ key: "business" });
    const response = ok(serialise(normaliseBusinessSettings(settings)));
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) {
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("settings.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = settingsSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the business settings.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const now = new Date();
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    let settings = normaliseBusinessSettings(input.data);
    try {
      await mongoSession.withTransaction(async () => {
        const current = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }, { session: mongoSession }));
        const nextInput = {
          ...input.data,
          workspaceLogoDataUrl: input.data.workspaceLogoDataUrl ?? current.workspaceLogoDataUrl,
        };
        if (auth.session.role !== "OWNER" && nextInput.workspaceTheme !== current.workspaceTheme) {
          throw new ThemeChangeForbidden("Only the Owner can change the workspace interface theme.");
        }
        if (auth.session.role !== "OWNER" && nextInput.workspaceLogoDataUrl !== current.workspaceLogoDataUrl) {
          throw new LogoChangeForbidden("Only the Owner can change the workspace logo.");
        }
        const currencyError = ledgerCurrencyChangeError(current.currency, nextInput.currency);
        if (currencyError) throw new CurrencyChangeConflict(currencyError);
        const changedFields = Object.keys(nextInput).filter((field) => JSON.stringify(current[field as keyof typeof current]) !== JSON.stringify(nextInput[field as keyof typeof nextInput]));
        if (!changedFields.length) { settings = current; return; }
        const updated = await db.collection("settings").findOneAndUpdate(
          { key: "business" },
          { $set: { ...nextInput, acceptedCurrencies: [...new Set(nextInput.acceptedCurrencies)], updatedAt: now, updatedBy: auth.session.id }, $setOnInsert: { key: "business", createdAt: now } },
          { upsert: true, returnDocument: "after", session: mongoSession },
        );
        settings = normaliseBusinessSettings(updated);
        if (current.countryCode !== settings.countryCode) {
          // Only replace untouched legacy starter wording, never custom text or document snapshots.
          await db.collection("receiptTemplates").updateOne(
            { systemKey: "starter-receipt-template", headerText: "KŌN-KŌN MATCHĀ · SINGAPORE" },
            { $set: { headerText: "KŌN-KŌN MATCHĀ", updatedAt: now } }, { session: mongoSession },
          );
          await db.collection("invoiceTemplates").updateOne(
            { systemKey: "starter-invoice-template", headerText: "KŌN-KŌN MATCHĀ · SINGAPORE" },
            { $set: { headerText: "KŌN-KŌN MATCHĀ", updatedAt: now } }, { session: mongoSession },
          );
          await db.collection("invoiceTemplates").updateOne(
            { systemKey: "starter-invoice-template", paymentInstructions: "Please include the invoice number with your bank transfer or PayNow payment." },
            { $set: { paymentInstructions: "Please include the invoice number with your payment using the agreed payment method.", updatedAt: now } }, { session: mongoSession },
          );
          await db.collection("chartOfAccounts").updateOne(
            { code: "2100", name: "GST payable" }, { $set: { name: "Tax payable" } }, { session: mongoSession },
          );
        }
        // Migrate only untouched starter copy. Running this on every real settings save also repairs
        // workspaces that changed their name before workspace-wide branding was introduced.
        await db.collection("invoiceTemplates").updateOne(
          { systemKey: "starter-invoice-template", headerText: { $in: ["KŌN-KŌN MATCHĀ", "KŌN-KŌN MATCHĀ · SINGAPORE"] } },
          { $set: { headerText: "ACCOUNTING & OPERATIONS", updatedAt: now } }, { session: mongoSession },
        );
        await db.collection("invoiceTemplates").updateOne(
          { systemKey: "starter-invoice-template", footerText: "Prepared with care by Kōn-Kōn Matchā." },
          { $set: { footerText: "Prepared with care for your records.", updatedAt: now } }, { session: mongoSession },
        );
        await db.collection("receiptTemplates").updateOne(
          { systemKey: "starter-receipt-template", headerText: { $in: ["KŌN-KŌN MATCHĀ", "KŌN-KŌN MATCHĀ · SINGAPORE"] } },
          { $set: { headerText: "SALES COUNTER", updatedAt: now } }, { session: mongoSession },
        );
        await db.collection("receiptTemplates").updateOne(
          { systemKey: "starter-receipt-template", footerText: "Prepared fresh at the Kōn-Kōn counter." },
          { $set: { footerText: "Prepared at the counter.", updatedAt: now } }, { session: mongoSession },
        );
        if (changedFields.length) {
          await db.collection("settingsHistory").insertOne({
            key: "business",
            changedFields,
            before: historySnapshot(current),
            after: historySnapshot(settings),
            changedBy: auth.session.id,
            changedByName: auth.session.fullName,
            createdAt: now,
          }, { session: mongoSession });
        }
        await writeAudit(db, auth.session, "settings.update", "workspace", "default", { fields: changedFields }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }
    return ok(serialise(settings));
  } catch (error) {
    if (error instanceof CurrencyChangeConflict) return fail(error.message, 409, { currency: [error.message] });
    if (error instanceof ThemeChangeForbidden) return fail(error.message, 403);
    if (error instanceof LogoChangeForbidden) return fail(error.message, 403);
    return publicError(error);
  }
}
