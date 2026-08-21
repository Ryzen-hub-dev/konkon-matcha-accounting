import { z } from "zod";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb, getMongoClient } from "@/lib/db";
import { serialise } from "@/lib/format";
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
}).superRefine((value, context) => {
  if (!value.acceptedCurrencies.includes(value.currency)) {
    context.addIssue({ code: "custom", path: ["acceptedCurrencies"], message: "Accepted currencies must include the workspace base currency." });
  }
  if (value.organizationType === "FRANCHISEE" && (!value.franchiseBrand || !value.franchiseCode || !value.parentOrganizationCode)) {
    context.addIssue({ code: "custom", path: ["franchiseCode"], message: "Franchisees require a brand, location code and parent organization code." });
  }
});

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
        const changedFields = Object.keys(input.data).filter((field) => JSON.stringify(current[field as keyof typeof current]) !== JSON.stringify(input.data[field as keyof typeof input.data]));
        const updated = await db.collection("settings").findOneAndUpdate(
          { key: "business" },
          { $set: { ...input.data, acceptedCurrencies: [...new Set(input.data.acceptedCurrencies)], updatedAt: now, updatedBy: auth.session.id }, $setOnInsert: { key: "business", createdAt: now } },
          { upsert: true, returnDocument: "after", session: mongoSession },
        );
        settings = normaliseBusinessSettings(updated);
        if (changedFields.length) {
          await db.collection("settingsHistory").insertOne({
            key: "business",
            changedFields,
            before: current,
            after: settings,
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
    return publicError(error);
  }
}
