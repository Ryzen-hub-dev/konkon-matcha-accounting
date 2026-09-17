import { ObjectId, type Document, type Filter } from "mongodb";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { operationalReviewActionSchema, REVIEW_CATEGORIES, REVIEW_STATUSES } from "@/lib/operational-reviews";

export const runtime = "nodejs";

function escapedSearch(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function GET(request: Request) {
  const auth = await authorize("reviews.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const url = new URL(request.url);
    const requestedStatus = url.searchParams.get("status") || "ACTIVE";
    const requestedCategory = url.searchParams.get("category") || "ALL";
    const query = url.searchParams.get("q")?.trim().slice(0, 60) || "";
    const filter: Filter<Document> = {};
    if (requestedStatus === "ACTIVE") filter.status = { $in: ["OPEN", "IN_REVIEW"] };
    else if (REVIEW_STATUSES.includes(requestedStatus as (typeof REVIEW_STATUSES)[number])) filter.status = requestedStatus;
    if (REVIEW_CATEGORIES.includes(requestedCategory as (typeof REVIEW_CATEGORIES)[number])) filter.category = requestedCategory;
    if (query) {
      const search = { $regex: escapedSearch(query), $options: "i" };
      filter.$or = ["reviewNo", "sourceNo", "title", "actorName"].map((field) => ({ [field]: search }));
    }
    const collection = db.collection("operationalReviews");
    const [reviews, open, inReview, high, security] = await Promise.all([
      collection.find(filter).sort({ status: 1, severityRank: -1, occurredAt: -1 }).limit(200).toArray(),
      collection.countDocuments({ status: "OPEN" }),
      collection.countDocuments({ status: "IN_REVIEW" }),
      collection.countDocuments({ status: { $in: ["OPEN", "IN_REVIEW"] }, severity: { $in: ["HIGH", "CRITICAL"] } }),
      collection.countDocuments({ status: { $in: ["OPEN", "IN_REVIEW"] }, category: "SECURITY" }),
    ]);
    return ok(serialise({ reviews, counts: { open, inReview, high, security } }));
  } catch (error) {
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("reviews.manage", { allowReadOnlyWrite: true });
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    let body: unknown;
    try { body = await request.json(); }
    catch { return fail("The request body must be valid JSON.", 400); }
    const input = operationalReviewActionSchema.safeParse(body);
    if (!input.success) return fail("Check the review action.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const id = new ObjectId(input.data.id);
    const current = await db.collection("operationalReviews").findOne({ _id: id });
    if (!current) return fail("This review item could not be found.", 404);
    if (input.data.action === "RESOLVE" && current.sourceType === "registerShift") {
      return fail("Approve the cash variance from Counters so the register state and review evidence stay synchronized.", 409);
    }
    if (input.data.action === "ACKNOWLEDGE" && current.status !== "OPEN") return fail("This item has already been acknowledged or resolved.", 409);
    if (input.data.action === "RESOLVE" && !["OPEN", "IN_REVIEW"].includes(String(current.status))) return fail("This item is no longer active.", 409);
    if (input.data.action === "REOPEN" && current.status !== "RESOLVED") return fail("Only a resolved item can be reopened.", 409);

    const now = new Date();
    const actorId = new ObjectId(auth.session.id);
    const history = { action: input.data.action, note: input.data.note, actorId, actorName: auth.session.fullName, actorRole: auth.session.role, createdAt: now };
    const baseSet: Record<string, unknown> = { updatedAt: now };
    const unset: Record<string, ""> = {};
    if (input.data.action === "ACKNOWLEDGE") Object.assign(baseSet, { status: "IN_REVIEW", assignedTo: actorId, assignedToName: auth.session.fullName, assignedAt: now });
    if (input.data.action === "RESOLVE") Object.assign(baseSet, { status: "RESOLVED", resolvedBy: actorId, resolvedByName: auth.session.fullName, resolvedAt: now, resolutionNote: input.data.note });
    if (input.data.action === "REOPEN") {
      Object.assign(baseSet, { status: "OPEN" });
      Object.assign(unset, { assignedTo: "", assignedToName: "", assignedAt: "", resolvedBy: "", resolvedByName: "", resolvedAt: "", resolutionNote: "" });
    }
    const update: Document = { $set: baseSet, $inc: { version: 1 }, $push: { history }, ...(Object.keys(unset).length ? { $unset: unset } : {}) };
    const updated = await db.collection("operationalReviews").findOneAndUpdate(
      { _id: id, version: input.data.version },
      update,
      { returnDocument: "after" },
    );
    if (!updated) return fail("This item changed while you were reviewing it. Refresh and try again.", 409);
    await writeAudit(db, auth.session, `operational_review.${input.data.action.toLowerCase()}`, "operationalReview", input.data.id, {
      reviewNo: current.reviewNo,
      sourceType: current.sourceType,
      sourceId: current.sourceId,
      note: input.data.note,
    });
    return ok(serialise(updated));
  } catch (error) {
    return publicError(error);
  }
}
