import { z } from "zod";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { getSystemControl } from "@/lib/system-control";

export const runtime = "nodejs";

const controlSchema = z.object({
  mode: z.enum(["OPEN", "READ_ONLY", "CLOSED"]),
  reason: z.string().trim().max(240).default(""),
  reopenInMinutes: z.coerce.number().int().min(0).max(10_080).default(0),
  revokeScannerLinks: z.boolean().default(true),
});

export async function GET() {
  const auth = await authorize("settings.read");
  if (auth.error) return auth.error;
  try {
    return ok(serialise(await getSystemControl(await getDb())));
  } catch (error) {
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("settings.write", { allowReadOnlyWrite: true });
  if (auth.error) return auth.error;
  if (auth.session.role !== "OWNER") return fail("Only the Owner can change workspace availability.", 403);
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = controlSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the system control details.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const now = new Date();
    const reopenAt = input.data.mode === "OPEN" || input.data.reopenInMinutes === 0
      ? null
      : new Date(now.getTime() + input.data.reopenInMinutes * 60_000);
    const update = {
      $set: {
        mode: input.data.mode,
        reason: input.data.mode === "OPEN" ? "" : input.data.reason,
        reopenAt,
        updatedBy: auth.session.id,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
      ...(input.data.revokeScannerLinks ? { $inc: { scannerGeneration: 1 } } : {}),
    };
    const control = await db.collection("systemControls").findOneAndUpdate(
      { _id: "workspace" as never },
      update,
      { upsert: true, returnDocument: "after" },
    );
    await writeAudit(db, auth.session, "system.mode_change", "workspace", "default", {
      mode: input.data.mode,
      reason: input.data.reason,
      reopenAt,
      scannerLinksRevoked: input.data.revokeScannerLinks,
    });
    return ok(serialise(control));
  } catch (error) {
    return publicError(error);
  }
}
