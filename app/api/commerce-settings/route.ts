import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import {
  commerceSettingsSchema,
  normaliseCommerceSettings,
} from "@/lib/online-orders";
import {
  googleSmtpSchema,
  readGoogleSmtp,
  safeGoogleSmtp,
  saveGoogleSmtp,
} from "@/lib/google-smtp";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const [settings, smtp] = await Promise.all([
      db.collection("settings").findOne({ key: "commerce" }),
      readGoogleSmtp(db),
    ]);
    return ok({
      store: normaliseCommerceSettings(settings),
      smtp: safeGoogleSmtp(smtp),
    });
  } catch (error) {
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      return fail("Check the online-order settings.", 422);
    const { action, ...values } = body;
    const db = await getDb();
    if (action === "SAVE_SMTP") {
      const parsed = googleSmtpSchema.safeParse(values);
      if (!parsed.success)
        return fail(
          "Check the Google SMTP settings.",
          422,
          parsed.error.flatten().fieldErrors,
        );
      const smtp = await saveGoogleSmtp(db, parsed.data);
      await writeAudit(
        db,
        auth.session,
        "commerce.smtp_configure",
        "commerceConnection",
        "google-smtp-v1",
        { email: smtp.email },
      );
      return ok({ smtp });
    }
    if (action !== "SAVE_STORE")
      return fail("Choose a supported settings action.", 422);
    const parsed = commerceSettingsSchema.safeParse(values);
    if (!parsed.success)
      return fail(
        "Check the online-order settings.",
        422,
        parsed.error.flatten().fieldErrors,
      );
    const store = parsed.data;
    const now = new Date();
    await db.collection("settings").updateOne(
      { key: "commerce" },
      {
        $set: { ...store, updatedAt: now, updatedBy: auth.session.id },
        $setOnInsert: { key: "commerce", createdAt: now },
      },
      { upsert: true },
    );
    await writeAudit(
      db,
      auth.session,
      "commerce.settings_update",
      "workspace",
      "commerce",
      { sensitiveFieldCount: store.sensitiveFields.length },
    );
    return ok({ store: normaliseCommerceSettings(store) });
  } catch (error) {
    if (error instanceof SyntaxError)
      return fail("The request body must be valid JSON.", 400);
    if (error instanceof Error && /SMTP|Google|password|credential/i.test(error.message))
      return fail(error.message, 422);
    return publicError(error);
  }
}
