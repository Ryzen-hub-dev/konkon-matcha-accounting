import { createHash } from "node:crypto";
import { ClientSession, Db, ObjectId } from "mongodb";
import {
  authorize,
  created,
  fail,
  ok,
  sameOrigin,
  publicError,
} from "@/lib/api";
import { getDb, getMongoClient } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { serialise } from "@/lib/format";
import {
  eInvoiceInputSchema,
  EInvoiceError,
  generateEInvoice,
} from "@/lib/e-invoices";
import { packDocument, unpackDocument } from "@/lib/document-storage";
import {
  OwnerRecoveryError,
  readOwnerRecoveryJson,
} from "@/lib/owner-recovery";
import { hasPermission } from "@/lib/rbac";
import { normaliseBusinessSettings } from "@/lib/business-settings";

export const runtime = "nodejs";
export const maxDuration = 30;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const metadata = {
  encryptedContent: 0,
  inputHash: 0,
  createdBy: 0,
  clientRequestId: 0,
  myInvoisSubmissionStartedBy: 0,
  myInvoisSubmittedBy: 0,
  myInvoisLinkedBy: 0,
};
type SourceType = "INVOICE" | "RECEIPT" | "PURCHASE_BILL";
const collectionFor = (sourceType: SourceType) =>
  sourceType === "INVOICE"
    ? "invoices"
    : sourceType === "RECEIPT"
      ? "sales"
      : "accountsPayableBills";
const permissionFor = (sourceType: SourceType, write = false) =>
  sourceType === "INVOICE"
    ? write
      ? "invoices.write"
      : "invoices.read"
    : sourceType === "RECEIPT"
      ? write
        ? "receipts.manage"
        : "receipts.read"
      : write
        ? "purchasing.write"
        : "purchasing.read";

async function loadEInvoiceSource(
  db: Db,
  sourceType: SourceType,
  sourceId: ObjectId,
  session?: ClientSession,
) {
  const source = await db
    .collection(collectionFor(sourceType))
    .findOne({ _id: sourceId }, session ? { session } : undefined);
  if (!source || sourceType !== "PURCHASE_BILL") return source;
  const [receipt, supplier, settings] = await Promise.all([
    db
      .collection("goodsReceipts")
      .findOne(
        { _id: source.goodsReceiptId },
        session ? { session } : undefined,
      ),
    db
      .collection("suppliers")
      .findOne({ _id: source.supplierId }, session ? { session } : undefined),
    db
      .collection("settings")
      .findOne({ key: "business" }, session ? { session } : undefined),
  ]);
  if (!receipt || !supplier)
    throw new EInvoiceError(
      "The supplier bill is missing its receipt or supplier master record.",
      409,
    );
  const business = normaliseBusinessSettings(settings);
  const items = (receipt.items as Array<Record<string, unknown>>).map(
    (line) => ({
      description: String(
        line.productName || line.description || line.sku || "Purchased item",
      ),
      quantity: Number(line.quantity),
      lineTotal: Number(line.lineTotal),
    }),
  );
  return {
    ...source,
    invoiceNo: source.billNo,
    createdAt: source.invoiceDate,
    businessSnapshot: {
      currency: source.currency,
      countryCode: supplier.countryCode,
      timeZone: source.timeZone || business.timeZone,
      legalEntityName: supplier.name,
      registrationNo: supplier.registrationNo,
      address: supplier.address,
      email: supplier.email,
      phone: supplier.phone,
    },
    subtotal: items.reduce((sum, line) => sum + line.lineTotal, 0),
    discount: 0,
    netSales: Number(source.total) - Number(source.tax || 0),
    taxRate: Number(receipt.taxRate || 0),
    refundedAmount: Number(source.creditedAmount || 0),
    items,
    workspaceBuyer: {
      name: business.businessName,
      registrationNo: business.registrationNo,
      address: business.address,
      email: business.email,
      phone: business.phone,
      countryCode: business.countryCode,
    },
  };
}
function errorResponse(error: unknown) {
  if (error instanceof EInvoiceError || error instanceof OwnerRecoveryError)
    return fail(error.message, error.status);
  return publicError(error);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sourceType = url.searchParams.get("sourceType");
  const sourceId = url.searchParams.get("sourceId") || "";
  if (
    !["INVOICE", "RECEIPT", "PURCHASE_BILL"].includes(sourceType || "") ||
    !ObjectId.isValid(sourceId)
  )
    return fail("Choose an invoice, receipt or supplier bill.", 422);
  const typedSource = sourceType as SourceType;
  const auth = await authorize(permissionFor(typedSource));
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const id = url.searchParams.get("id");
    if (id) {
      if (!ObjectId.isValid(id))
        return fail("Choose a generated document.", 422);
      const artifact = await db
        .collection("eInvoices")
        .findOne({
          _id: new ObjectId(id),
          sourceType,
          sourceId: new ObjectId(sourceId),
        });
      if (!artifact) return fail("The generated document was not found.", 404);
      let content: string;
      try {
        content = unpackDocument(
          {
            encryptedContent: artifact.encryptedContent,
            contentEncoding: artifact.contentEncoding,
            sha256: artifact.sha256,
          },
          `einvoice:${id}`,
        );
      } catch {
        throw new EInvoiceError(
          "Document integrity check failed. Ask the Owner to restore a verified backup.",
          503,
        );
      }
      await writeAudit(db, auth.session, "einvoice.download", "eInvoice", id);
      return new Response(content, {
        headers: {
          "Content-Type": `${artifact.mimeType};charset=utf-8`,
          "Content-Disposition": `attachment; filename="${artifact.filename}"`,
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
          "X-Document-SHA256": artifact.sha256,
        },
      });
    }
    const source = await loadEInvoiceSource(
      db,
      typedSource,
      new ObjectId(sourceId),
    );
    if (!source) return fail("The original document was not found.", 404);
    const snapshot = source.businessSnapshot || {};
    // Created-at values can share the same millisecond during a fast retry or
    // browser interaction. Use the ObjectId as a stable insertion-order tie
    // breaker so the newest snapshot is always shown/downloaded first.
    const history = await db
      .collection("eInvoices")
      .find({ sourceType, sourceId: source._id }, { projection: metadata })
      .sort({ createdAt: -1, _id: -1 })
      .limit(50)
      .toArray();
    return ok(
      serialise({
        canGenerate: hasPermission(
          auth.session.role,
          permissionFor(typedSource, true),
        ),
        canSubmitMyInvois: hasPermission(auth.session.role, "owner.control"),
        sourceStatus: source.status,
        countryCode: snapshot.countryCode || "",
        currency: snapshot.currency || "",
        total: source.total,
        tax: source.tax,
        seller: {
          name: snapshot.legalEntityName || snapshot.businessName || "",
          registrationNo: snapshot.registrationNo || "",
          address: snapshot.address || "",
          email: snapshot.email || "",
          phone: snapshot.phone || "",
          countryCode: snapshot.countryCode || "",
        },
        buyer:
          sourceType === "PURCHASE_BILL"
            ? source.workspaceBuyer
            : {
                name: source.customerName || "",
                registrationNo: "",
                address: source.customerAddress || "",
                email: source.customerEmail || "",
                phone: source.customerPhone || "",
                countryCode: snapshot.countryCode || "",
              },
        history,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const parsed = eInvoiceInputSchema.safeParse(
      await readOwnerRecoveryJson(request),
    );
    if (!parsed.success)
      return fail(
        `Check e-invoice details: ${parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
        422,
        parsed.error.flatten().fieldErrors,
      );
    const input = parsed.data;
    const auth = await authorize(permissionFor(input.sourceType, true));
    if (auth.error) return auth.error;
    const db = await getDb();
    const mongoSession = (await getMongoClient()).startSession();
    const inputHash = digest(JSON.stringify(input));
    try {
      const result = await mongoSession.withTransaction(async () => {
        const existing = await db
          .collection("eInvoices")
          .findOne(
            {
              createdBy: new ObjectId(auth.session.id),
              clientRequestId: input.clientRequestId,
            },
            { session: mongoSession },
          );
        if (existing) {
          if (existing.inputHash !== inputHash)
            throw new EInvoiceError(
              "This generation request was already used with different details. Start a new request.",
              409,
            );
          return {
            id: existing._id.toHexString(),
            sha256: existing.sha256,
            reused: true,
          };
        }
        const sourceId = new ObjectId(input.sourceId);
        const collection = db.collection(collectionFor(input.sourceType));
        const source = await loadEInvoiceSource(
          db,
          input.sourceType,
          sourceId,
          mongoSession,
        );
        if (!source)
          throw new EInvoiceError("The original document was not found.", 404);
        if (
          (await db
            .collection("eInvoices")
            .countDocuments(
              { sourceType: input.sourceType, sourceId },
              { session: mongoSession },
            )) >= 50
        )
          throw new EInvoiceError(
            "This source already has 50 generated snapshots. Download an existing document.",
            409,
          );
        const generated = generateEInvoice(source, input);
        if (Buffer.byteLength(generated.content) > 1_000_000)
          throw new EInvoiceError(
            "The generated document exceeds the 1 MB export limit.",
            413,
          );
        const _id = new ObjectId();
        const sha256 = digest(generated.content);
        // A source write makes concurrent payment/refund transactions conflict and retry.
        await collection.updateOne(
          { _id: sourceId },
          { $set: { lastEInvoiceGeneratedAt: new Date() } },
          { session: mongoSession },
        );
        await db
          .collection("eInvoices")
          .insertOne(
            {
              _id,
              sourceType: input.sourceType,
              sourceId,
              sourceStatus: source.status,
              sourceUpdatedAt: source.updatedAt || source.createdAt,
              number: generated.document.number,
              format: input.format,
              countryCode: generated.document.countryCode,
              currency: generated.document.currency,
              total: generated.document.totals.gross,
              status: "GENERATED_NOT_SUBMITTED",
              validation: "LOCAL_STRUCTURE_AND_TOTALS_ONLY",
              filename: generated.filename,
              mimeType: generated.mimeType,
              sha256,
              ...packDocument(
                generated.content,
                `einvoice:${_id.toHexString()}`,
              ),
              inputHash,
              clientRequestId: input.clientRequestId,
              createdBy: new ObjectId(auth.session.id),
              createdAt: new Date(),
            },
            { session: mongoSession },
          );
        await writeAudit(
          db,
          auth.session,
          "einvoice.generate",
          "eInvoice",
          _id.toHexString(),
          {
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            format: input.format,
            sha256,
          },
          mongoSession,
        );
        return { id: _id.toHexString(), sha256, reused: false };
      });
      return created({ ...result, status: "GENERATED_NOT_SUBMITTED" });
    } finally {
      await mongoSession.endSession();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
