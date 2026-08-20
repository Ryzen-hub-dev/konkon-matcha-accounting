import { z } from "zod";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";

export const runtime = "nodejs";

const settingsSchema = z.object({
  businessName: z.string().trim().min(2).max(100),
  registrationNo: z.string().trim().max(60).default(""),
  email: z.union([z.string().trim().email(), z.literal("")]).default(""),
  phone: z.string().trim().max(30).default(""),
  address: z.string().trim().max(300).default(""),
  currency: z.enum(["SGD"]),
  taxName: z.string().trim().min(2).max(20),
  taxRate: z.coerce.number().min(0).max(100),
  pointsPerDollar: z.coerce.number().min(0).max(100),
  lowStockNotifications: z.boolean().default(true),
});

export async function GET() {
  const auth = await authorize("settings.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const settings = await db.collection("settings").findOne({ key: "business" });
    return ok(serialise(settings || { key: "business", businessName: "Kōn-Kōn Matchā", currency: "SGD", taxName: "GST", taxRate: 0, pointsPerDollar: 1 }));
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
    const settings = await db.collection("settings").findOneAndUpdate(
      { key: "business" },
      { $set: { ...input.data, updatedAt: now }, $setOnInsert: { key: "business", createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    await writeAudit(db, auth.session, "settings.update", "workspace", "default", { fields: Object.keys(input.data) });
    return ok(serialise(settings));
  } catch (error) {
    return publicError(error);
  }
}
