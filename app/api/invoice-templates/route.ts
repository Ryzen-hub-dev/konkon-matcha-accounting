import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { ensureDefaultInvoiceTemplate, invoiceTemplateInputSchema } from "@/lib/invoice-templates";
import { serialise } from "@/lib/format";

export const runtime = "nodejs";

const updateSchema = invoiceTemplateInputSchema.extend({ id: z.string().length(24) });

async function readBody(request: Request) {
  try {
    return { value: await request.json() } as const;
  } catch {
    return { error: fail("The request body must be valid JSON.", 400) } as const;
  }
}

export async function GET() {
  const auth = await authorize("invoices.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    await ensureDefaultInvoiceTemplate(db, new ObjectId(auth.session.id));
    const templates = await db.collection("invoiceTemplates")
      .find({ active: { $ne: false } })
      .sort({ isDefault: -1, updatedAt: -1 })
      .limit(100)
      .toArray();
    return ok(serialise(templates));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("invoices.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = invoiceTemplateInputSchema.safeParse(body.value);
  if (!input.success) return fail("Check the template details.", 422, input.error.flatten().fieldErrors);

  try {
    const db = await getDb();
    const now = new Date();
    const document = {
      ...input.data,
      nameNormalized: input.data.name.toLocaleLowerCase("en-SG"),
      active: true,
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
      updatedAt: now,
    };
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    let insertedId = new ObjectId();
    try {
      await mongoSession.withTransaction(async () => {
        if (document.isDefault) {
          await db.collection("invoiceTemplates").updateMany({}, { $set: { isDefault: false } }, { session: mongoSession });
        }
        const result = await db.collection("invoiceTemplates").insertOne(document, { session: mongoSession });
        insertedId = result.insertedId;
        await writeAudit(db, auth.session, "invoice-template.create", "invoice-template", insertedId.toHexString(), { name: document.name }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }
    return created(serialise({ _id: insertedId, ...document }));
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && String(error.code) === "11000") {
      return fail("A template with this name already exists.", 409);
    }
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("invoices.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = updateSchema.safeParse(body.value);
  if (!input.success || !ObjectId.isValid(input.data?.id || "")) {
    return fail("Check the template details.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
  }

  try {
    const db = await getDb();
    const _id = new ObjectId(input.data.id);
    const current = await db.collection("invoiceTemplates").findOne({ _id, active: { $ne: false } });
    if (!current) return fail("This invoice template no longer exists.", 404);
    const { id: _ignored, ...template } = input.data;
    if (current.isDefault && !template.isDefault) template.isDefault = true;
    const update = {
      ...template,
      nameNormalized: template.name.toLocaleLowerCase("en-SG"),
      updatedAt: new Date(),
    };
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    let saved = current;
    try {
      await mongoSession.withTransaction(async () => {
        if (update.isDefault) {
          await db.collection("invoiceTemplates").updateMany({ _id: { $ne: _id } }, { $set: { isDefault: false } }, { session: mongoSession });
        }
        const result = await db.collection("invoiceTemplates").findOneAndUpdate(
          { _id },
          { $set: update },
          { returnDocument: "after", session: mongoSession },
        );
        if (!result) throw new Error("Invoice template changed while it was being saved.");
        saved = result;
        await writeAudit(db, auth.session, "invoice-template.update", "invoice-template", input.data.id, { name: update.name }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }
    return ok(serialise(saved));
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && String(error.code) === "11000") {
      return fail("A template with this name already exists.", 409);
    }
    return publicError(error);
  }
}
