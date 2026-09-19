import { ObjectId } from "mongodb";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { buildCustomerStatement, customerAccountUpdateSchema, type StatementInvoice } from "@/lib/customer-accounts";
import { dateKeyInTimeZone } from "@/lib/dates";
import { getDb } from "@/lib/db";
import { DimensionSelectionError, resolveDimensionPair } from "@/lib/dimension-selection";
import { serialise } from "@/lib/format";
import { roundCurrency } from "@/lib/international";

export const runtime = "nodejs";

const memberProjection = {
  memberNo: 1, name: 1, email: 1, phone: 1, active: 1,
  creditLimit: 1, creditTermsDays: 1, creditHold: 1, updatedAt: 1,
  dimensionDefaults: 1,
};

export async function GET(request: Request) {
  const auth = await authorize("invoices.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "";
    const settings = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const today = dateKeyInTimeZone(new Date(), settings.timeZone);
    if (id) {
      if (!ObjectId.isValid(id)) return fail("The customer account reference is invalid.", 422);
      const memberId = new ObjectId(id);
      const [member, invoices] = await Promise.all([
        db.collection("members").findOne({ _id: memberId }, { projection: memberProjection }),
        db.collection("invoices").find(
          {
            memberId,
            status: { $in: ["SENT", "PAID", "VOID"] },
            $or: [{ "businessSnapshot.currency": settings.currency }, { "businessSnapshot.currency": { $exists: false } }],
          },
          { projection: { invoiceNo: 1, status: 1, total: 1, paidAmount: 1, createdAt: 1, sentAt: 1, paidAt: 1, updatedAt: 1, dueDate: 1, customerReference: 1 } },
        ).sort({ createdAt: 1 }).limit(500).toArray(),
      ]);
      if (!member) return fail("This customer account could not be found.", 404);
      return ok(serialise({
        account: {
          ...member,
          creditLimit: member.creditLimit ?? null,
          creditTermsDays: Number(member.creditTermsDays ?? 14),
          creditHold: member.creditHold === true,
        },
        currency: settings.currency,
        generatedAt: new Date(),
        ...buildCustomerStatement(invoices as StatementInvoice[], settings.currency, today),
      }));
    }

    const dueBefore = new Date(`${today}T00:00:00.000Z`);
    const [members, metrics, dimensions] = await Promise.all([
      db.collection("members").find({ active: { $ne: false } }, { projection: memberProjection }).sort({ name: 1 }).limit(500).toArray(),
      db.collection("invoices").aggregate([
        { $match: {
          memberId: { $type: "objectId" },
          status: { $in: ["SENT", "PAID"] },
          $or: [{ "businessSnapshot.currency": settings.currency }, { "businessSnapshot.currency": { $exists: false } }],
        } },
        { $group: {
          _id: "$memberId",
          outstanding: { $sum: { $cond: [{ $eq: ["$status", "SENT"] }, { $subtract: ["$total", { $ifNull: ["$paidAmount", 0] }] }, 0] } },
          overdue: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "SENT"] }, { $lt: ["$dueDate", dueBefore] }] }, { $subtract: ["$total", { $ifNull: ["$paidAmount", 0] }] }, 0] } },
          openInvoices: { $sum: { $cond: [{ $eq: ["$status", "SENT"] }, 1, 0] } },
          lastInvoiceAt: { $max: "$createdAt" },
        } },
      ]).toArray(),
      db.collection("accountingDimensions").find({}).project({ type: 1, code: 1, name: 1, active: 1 }).sort({ type: 1, code: 1 }).toArray(),
    ]);
    const byMember = new Map(metrics.map(metric => [String(metric._id), metric]));
    return ok(serialise({
      currency: settings.currency,
      dimensions: dimensions.map(dimension => ({ _id: dimension._id, type: dimension.type, code: dimension.code, name: dimension.name, active: dimension.active !== false })),
      accounts: members.map(member => {
        const metric = byMember.get(String(member._id));
        const outstanding = roundCurrency(Number(metric?.outstanding || 0), settings.currency);
        const limit = member.creditLimit === null || member.creditLimit === undefined ? null : Number(member.creditLimit);
        return {
          ...member,
          creditLimit: limit,
          creditTermsDays: Number(member.creditTermsDays ?? 14),
          creditHold: member.creditHold === true,
          outstanding,
          overdue: roundCurrency(Number(metric?.overdue || 0), settings.currency),
          openInvoices: Number(metric?.openInvoices || 0),
          lastInvoiceAt: metric?.lastInvoiceAt || null,
          availableCredit: limit === null ? null : roundCurrency(Math.max(0, limit - outstanding), settings.currency),
        };
      }),
    }));
  } catch (error) {
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("invoices.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  let body: unknown;
  try { body = await request.json(); }
  catch { return fail("The request body must be valid JSON.", 400); }
  try {
    const input = customerAccountUpdateSchema.safeParse(body);
    if (!input.success) return fail("Check the customer account controls.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const settings = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const _id = new ObjectId(input.data.id);
    const current = await db.collection("members").findOne({ _id, active: { $ne: false } }, { projection: memberProjection });
    if (!current) return fail("This customer account could not be found.", 404);
    const expected = new Date(input.data.expectedUpdatedAt);
    if (!(current.updatedAt instanceof Date) || current.updatedAt.getTime() !== expected.getTime()) {
      return fail("This customer account changed. Refresh it before saving.", 409);
    }
    const updatedAt = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
    const creditLimit = input.data.creditLimit === null ? null : roundCurrency(input.data.creditLimit, settings.currency);
    const dimensionDefaults = input.data.dimensionDefaults
      ? await resolveDimensionPair(db, input.data.dimensionDefaults)
      : current.dimensionDefaults || {};
    const updated = await db.collection("members").findOneAndUpdate(
      { _id, active: { $ne: false }, updatedAt: current.updatedAt },
      { $set: { creditLimit, creditTermsDays: input.data.creditTermsDays, creditHold: input.data.creditHold, dimensionDefaults, updatedAt } },
      { returnDocument: "after", projection: memberProjection },
    );
    if (!updated) return fail("This customer account changed. Refresh it before saving.", 409);
    await writeAudit(db, auth.session, "customer.credit_controls", "member", input.data.id, {
      memberNo: current.memberNo,
      previous: { creditLimit: current.creditLimit ?? null, creditTermsDays: current.creditTermsDays ?? 14, creditHold: current.creditHold === true, costCentreCode: current.dimensionDefaults?.costCentre?.code || "", projectCode: current.dimensionDefaults?.project?.code || "" },
      next: { creditLimit, creditTermsDays: input.data.creditTermsDays, creditHold: input.data.creditHold, costCentreCode: dimensionDefaults.costCentre?.code || "", projectCode: dimensionDefaults.project?.code || "" },
      reason: input.data.reason,
    });
    return ok(serialise({
      ...updated,
      creditLimit: updated.creditLimit ?? null,
      creditTermsDays: Number(updated.creditTermsDays ?? 14),
      creditHold: updated.creditHold === true,
    }));
  } catch (error) {
    if (error instanceof DimensionSelectionError) return fail(error.message, 422);
    return publicError(error);
  }
}
