import { z } from "zod";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { currencyCodeSchema, normaliseExchangeRate } from "@/lib/international";

export const runtime = "nodejs";

const rateSchema = z.object({
  quoteCurrency: currencyCodeSchema,
  rate: z.coerce.number().positive().max(1_000_000_000),
  source: z.string().trim().max(60).default("MANUAL"),
});

export async function GET() {
  const auth = await authorize("payments.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const rates = await db.collection("exchangeRates").find({ baseCurrency: business.currency, active: { $ne: false } }).sort({ quoteCurrency: 1 }).toArray();
    const response = ok(serialise({
      baseCurrency: business.currency,
      acceptedCurrencies: business.acceptedCurrencies,
      rates: [{ baseCurrency: business.currency, quoteCurrency: business.currency, rate: 1, source: "BASE", effectiveAt: new Date(0) }, ...rates],
    }));
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) { return publicError(error); }
}
export async function PATCH(request: Request) {
  const auth = await authorize("payments.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = rateSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the exchange rate.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    if (input.data.quoteCurrency === business.currency) return fail("The base currency always uses a rate of 1.", 422);
    if (!business.acceptedCurrencies.includes(input.data.quoteCurrency)) return fail("Add this currency to accepted settlement currencies first.", 422);
    const now = new Date();
    const rate = normaliseExchangeRate(input.data.rate);
    const saved = await db.collection("exchangeRates").findOneAndUpdate(
      { baseCurrency: business.currency, quoteCurrency: input.data.quoteCurrency },
      { $set: { rate, source: input.data.source, active: true, effectiveAt: now, updatedAt: now, updatedBy: auth.session.id }, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    await writeAudit(db, auth.session, "exchange_rate.update", "exchangeRate", `${business.currency}-${input.data.quoteCurrency}`, { rate, source: input.data.source });
    return ok(serialise(saved));
  } catch (error) { return publicError(error); }
}
