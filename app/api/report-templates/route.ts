import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";
import {
  authorize,
  created,
  fail,
  ok,
  publicError,
  sameOrigin,
} from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { reportTemplateMutationSchema } from "@/lib/report-templates";
import { hasPermission } from "@/lib/rbac";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authorize("reports.read");
  if (auth.error) return auth.error;
  try {
    const templates = await (
      await getDb()
    )
      .collection("reportTemplates")
      .find({})
      .sort({ reportType: 1, nameNormalized: 1 })
      .limit(50)
      .toArray();
    return ok(
      serialise({
        templates,
        canDesign: hasPermission(auth.session.role, "reports.design"),
      }),
    );
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("reports.design");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = reportTemplateMutationSchema.safeParse(await request.json());
    if (!input.success)
      return fail(
        "Check the report layout.",
        422,
        input.error.flatten().fieldErrors,
      );
    const db = await getDb();
    if (input.data.action === "DELETE") {
      const removed = await db.collection("reportTemplates").findOneAndDelete({
        _id: new ObjectId(input.data.id),
        version: input.data.expectedVersion,
      });
      if (!removed)
        return fail("This report layout changed or no longer exists.", 409);
      await writeAudit(
        db,
        auth.session,
        "report_template.delete",
        "reportTemplate",
        input.data.id,
        { name: removed.name, reportType: removed.reportType },
      );
      return ok({ deleted: true });
    }
    const { action: _action, id, expectedVersion, ...values } = input.data;
    const now = new Date();
    const document = {
      ...values,
      nameNormalized: values.name.toLocaleLowerCase("en-US"),
      updatedBy: new ObjectId(auth.session.id),
      updatedByName: auth.session.fullName,
      updatedAt: now,
    };
    if (id) {
      const updated = await db
        .collection("reportTemplates")
        .findOneAndUpdate(
          { _id: new ObjectId(id), version: expectedVersion },
          { $set: document, $inc: { version: 1 } },
          { returnDocument: "after" },
        );
      if (!updated)
        return fail("This report layout changed. Reload and try again.", 409);
      await writeAudit(
        db,
        auth.session,
        "report_template.update",
        "reportTemplate",
        id,
        { name: document.name, reportType: document.reportType },
      );
      return ok(serialise(updated));
    }
    if ((await db.collection("reportTemplates").countDocuments({})) >= 50)
      return fail(
        "Keep at most 50 report layouts. Delete one before adding another.",
        409,
      );
    const templateId = new ObjectId(
      createHash("sha256")
        .update(`report-template:${document.nameNormalized}`)
        .digest("hex")
        .slice(0, 24),
    );
    await db.collection("reportTemplates").insertOne({
      _id: templateId,
      ...document,
      version: 1,
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
    });
    await writeAudit(
      db,
      auth.session,
      "report_template.create",
      "reportTemplate",
      templateId.toHexString(),
      { name: document.name, reportType: document.reportType },
    );
    return created(serialise({ _id: templateId, ...document, version: 1 }));
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      return fail("A report layout with that name already exists.", 409);
    return publicError(error);
  }
}
