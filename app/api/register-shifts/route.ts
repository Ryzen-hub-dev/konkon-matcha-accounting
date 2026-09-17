import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { hasPermission } from "@/lib/rbac";
import { paymentCurrencies } from "@/lib/payment-methods";
import { assessRegisterVariance, resolveLinkedOperationalReview, writeOperationalReview } from "@/lib/operational-reviews";
import {
  calculateRegisterShiftSummary,
  normaliseCashCounts,
  registerShiftActionSchema,
  registerShiftOpenSchema,
  registerSummaryNeedsReview,
  type CashCount,
} from "@/lib/register-shifts";

export const runtime = "nodejs";

async function readBody(request: Request) {
  try {
    return { value: await request.json() } as const;
  } catch {
    return { error: fail("The request body must be valid JSON.", 400) } as const;
  }
}

function canUseCounter(session: { id: string; role: string }, counter: Record<string, unknown>) {
  if (session.role !== "MANAGER") return true;
  const managerIds = Array.isArray(counter.managerIds) ? counter.managerIds : [];
  return !managerIds.length || managerIds.some((id) => String(id) === session.id);
}

function cashForCurrencies(values: CashCount[], currencies: string[]) {
  const valueMap = new Map(normaliseCashCounts(values).map((entry) => [entry.currency, entry.amount]));
  return currencies.map((currency) => ({ currency, amount: valueMap.get(currency) || 0 }));
}

function unsupportedCashCurrency(values: CashCount[], currencies: string[]) {
  const allowed = new Set(currencies);
  return values.find((entry) => !allowed.has(entry.currency));
}

async function registerCashConfig(db: Awaited<ReturnType<typeof getDb>>) {
  const [settings, cashMethods] = await Promise.all([
    db.collection("settings").findOne({ key: "business" }),
    db.collection("paymentMethods").find({ active: { $ne: false }, kind: "CASH" }).toArray(),
  ]);
  const business = normaliseBusinessSettings(settings);
  const cashCurrencies = [...new Set(cashMethods.flatMap((method) => paymentCurrencies(method, business.currency, business.acceptedCurrencies)))];
  return { business, cashCurrencies: cashCurrencies.length ? cashCurrencies : [business.currency] };
}

export async function GET() {
  const auth = await authorize("counters.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const [active, recent, controlledCounterIds, cashConfig] = await Promise.all([
      db.collection("registerShifts").find({ status: { $in: ["OPEN", "PENDING_REVIEW"] } }).sort({ openedAt: -1 }).toArray(),
      db.collection("registerShifts").find({ status: "CLOSED" }).sort({ closedAt: -1 }).limit(50).toArray(),
      db.collection("registerShifts").distinct("counterId"),
      registerCashConfig(db),
    ]);
    const canReview = hasPermission(auth.session.role, "receipts.manage");
    const shifts = await Promise.all([...active, ...recent].map(async (shift) => {
      if (shift.status !== "OPEN" || !canReview) return shift;
      return { ...shift, liveSummary: await calculateRegisterShiftSummary(db, shift as { _id: ObjectId; currency: string; openingCash: CashCount[] }) };
    }));
    return ok(serialise({ shifts, controlledCounterIds: controlledCounterIds.map(String), cashCurrencies: cashConfig.cashCurrencies }));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = registerShiftOpenSchema.safeParse(body.value);
  if (!input.success) return fail("Check the opening cash and counter.", 422, input.error.flatten().fieldErrors);
  try {
    const db = await getDb();
    const actorId = new ObjectId(auth.session.id);
    const existing = await db.collection("registerShifts").findOne({ openRequestId: input.data.clientRequestId, openedBy: actorId });
    if (existing) return ok(serialise(existing));
    const [counter, cashConfig] = await Promise.all([
      db.collection("counters").findOne({ _id: new ObjectId(input.data.counterId), active: { $ne: false } }),
      registerCashConfig(db),
    ]);
    if (!counter) return fail("Choose an active counter.", 422, { counterId: ["This counter is unavailable."] });
    if (!canUseCounter(auth.session, counter)) return fail("This Manager is not bound to the selected counter.", 403);
    if (!ObjectId.isValid(String(counter.locationId || ""))) return fail("The selected counter has an invalid location.", 409);
    const location = await db.collection("locations").findOne({ _id: new ObjectId(String(counter.locationId)), active: { $ne: false } });
    if (!location) return fail("The selected counter's location is inactive.", 409);
    const { business, cashCurrencies: activeCurrencies } = cashConfig;
    const unsupported = unsupportedCashCurrency(input.data.openingCash, activeCurrencies);
    if (unsupported) return fail(`${unsupported.currency} is not an accepted settlement currency.`, 422, { openingCash: ["Use only configured currencies."] });
    const openingCash = cashForCurrencies(input.data.openingCash, activeCurrencies);
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    let shift: Record<string, unknown> | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const unresolved = await db.collection("registerShifts").findOne(
          { counterId: counter._id, status: { $in: ["OPEN", "PENDING_REVIEW"] } },
          { session: mongoSession },
        );
        if (unresolved) throw new Error(unresolved.status === "PENDING_REVIEW" ? "SHIFT_REVIEW_REQUIRED" : "SHIFT_ALREADY_OPEN");
        const now = new Date();
        shift = {
          _id: new ObjectId(),
          shiftNo: makeDocumentNo("SHIFT"),
          openRequestId: input.data.clientRequestId,
          counterId: counter._id,
          counterCode: String(counter.code),
          counterName: String(counter.name),
          locationId: location._id,
          locationName: String(location.name),
          currency: business.currency,
          activeCurrencies,
          openingCash,
          status: "OPEN",
          openedBy: actorId,
          openedByName: auth.session.fullName,
          openedByRole: auth.session.role,
          openedAt: now,
          lastActivityAt: now,
        };
        await db.collection("registerShifts").insertOne(shift, { session: mongoSession });
        await writeAudit(db, auth.session, "register.shift.open", "registerShift", String(shift._id), {
          shiftNo: shift.shiftNo,
          counterCode: counter.code,
          openingCash,
        }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }
    return created(serialise(shift));
  } catch (error) {
    if (error instanceof Error && error.message === "SHIFT_ALREADY_OPEN") return fail("This counter already has an open shift.", 409);
    if (error instanceof Error && error.message === "SHIFT_REVIEW_REQUIRED") return fail("Review the previous cash variance before opening another shift.", 409);
    if ((error as { code?: number }).code === 11000) return fail("This counter already has an open shift, or the opening request was already used.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("pos.sell", { allowReadOnlyWrite: true });
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = registerShiftActionSchema.safeParse(body.value);
  if (!input.success) return fail("Check the shift action.", 422, input.error.flatten().fieldErrors);
  const canReview = hasPermission(auth.session.role, "receipts.manage");
  if (input.data.action === "APPROVE" && !canReview) return fail("A Manager or administrator must review this cash variance.", 403);
  try {
    const db = await getDb();
    const actorId = new ObjectId(auth.session.id);
    if (input.data.action === "CLOSE") {
      const repeated = await db.collection("registerShifts").findOne({ closeRequestId: input.data.clientRequestId });
      if (repeated) return ok(serialise(repeated));
    }
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    let updated: Record<string, unknown> | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const shift = await db.collection("registerShifts").findOne({ _id: new ObjectId(input.data.id) }, { session: mongoSession });
        if (!shift) throw new Error("SHIFT_NOT_FOUND");
        if (input.data.action === "APPROVE") {
          if (shift.status !== "PENDING_REVIEW") throw new Error("SHIFT_NOT_PENDING");
          const reviewedAt = new Date();
          const result = await db.collection("registerShifts").findOneAndUpdate(
            { _id: shift._id, status: "PENDING_REVIEW" },
            { $set: { status: "CLOSED", reviewedBy: actorId, reviewedByName: auth.session.fullName, reviewedAt, reviewNote: input.data.note, updatedAt: reviewedAt } },
            { returnDocument: "after", session: mongoSession },
          );
          if (!result) throw new Error("SHIFT_NOT_PENDING");
          updated = result;
          await resolveLinkedOperationalReview(db, "registerShift", input.data.id, auth.session, input.data.note, mongoSession);
          await writeAudit(db, auth.session, "register.shift.approve", "registerShift", input.data.id, {
            shiftNo: shift.shiftNo,
            note: input.data.note,
            variances: shift.summary?.cashByCurrency,
          }, mongoSession);
          return;
        }
        if (shift.status !== "OPEN") throw new Error("SHIFT_NOT_OPEN");
        if (!canReview && String(shift.openedBy) !== auth.session.id) throw new Error("SHIFT_NOT_OWNER");
        const activeCurrencies = Array.isArray(shift.activeCurrencies) ? shift.activeCurrencies.map(String) : [String(shift.currency)];
        const unsupported = unsupportedCashCurrency(input.data.countedCash, activeCurrencies);
        if (unsupported) throw new Error("SHIFT_CURRENCY_INVALID");
        const countedCash = cashForCurrencies(input.data.countedCash, activeCurrencies);
        const summary = await calculateRegisterShiftSummary(
          db,
          shift as { _id: ObjectId; currency: string; openingCash: CashCount[] },
          countedCash,
          mongoSession,
        );
        const needsReview = registerSummaryNeedsReview(summary);
        const status = needsReview && !canReview ? "PENDING_REVIEW" : "CLOSED";
        const closedAt = new Date();
        const result = await db.collection("registerShifts").findOneAndUpdate(
          { _id: shift._id, status: "OPEN" },
          { $set: {
            status,
            closeRequestId: input.data.clientRequestId,
            countedCash,
            summary,
            closeNote: input.data.note,
            closedBy: actorId,
            closedByName: auth.session.fullName,
            closedAt,
            updatedAt: closedAt,
            ...(needsReview && canReview ? { reviewedBy: actorId, reviewedByName: auth.session.fullName, reviewedAt: closedAt, reviewNote: input.data.note || "Reviewed while closing." } : {}),
          } },
          { returnDocument: "after", session: mongoSession },
        );
        if (!result) throw new Error("SHIFT_NOT_OPEN");
        updated = result;
        if (needsReview && !canReview) {
          await writeOperationalReview(db, assessRegisterVariance(summary.cashByCurrency), {
            sourceType: "registerShift",
            sourceId: String(shift._id),
            sourceNo: String(shift.shiftNo),
            sourceHref: "/counters",
            occurredAt: closedAt,
            actor: auth.session,
            currency: String(shift.currency),
          }, mongoSession);
        }
        await writeAudit(db, auth.session, "register.shift.close", "registerShift", input.data.id, {
          shiftNo: shift.shiftNo,
          status,
          note: input.data.note,
          grossSales: summary.grossSales,
          refunds: summary.refunds,
          netSales: summary.netSales,
          cashByCurrency: summary.cashByCurrency,
        }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }
    return ok(serialise(updated));
  } catch (error) {
    if (error instanceof Error && error.message === "SHIFT_NOT_FOUND") return fail("This register shift could not be found.", 404);
    if (error instanceof Error && error.message === "SHIFT_NOT_OPEN") return fail("This register shift is no longer open.", 409);
    if (error instanceof Error && error.message === "SHIFT_NOT_PENDING") return fail("This shift no longer needs review.", 409);
    if (error instanceof Error && error.message === "SHIFT_NOT_OWNER") return fail("Only the opening operator or a Manager can close this shift.", 403);
    if (error instanceof Error && error.message === "SHIFT_CURRENCY_INVALID") return fail("Count cash only in the currencies configured when this shift opened.", 422);
    if ((error as { code?: number }).code === 11000 && input.data.action === "CLOSE") {
      const db = await getDb();
      const repeated = await db.collection("registerShifts").findOne({ closeRequestId: input.data.clientRequestId });
      if (repeated) return ok(serialise(repeated));
    }
    return publicError(error);
  }
}
