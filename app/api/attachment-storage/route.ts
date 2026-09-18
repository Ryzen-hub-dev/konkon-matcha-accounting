import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { attachmentStorageInputSchema, getAttachmentStorageConfig, safeAttachmentStorage, saveAttachmentStorageConfig } from "@/lib/attachment-storage";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  try { return ok(safeAttachmentStorage(await getAttachmentStorageConfig(await getDb()))); }
  catch (error) { return publicError(error); }
}

export async function PATCH(request: Request) {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = attachmentStorageInputSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the private repository settings.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const saved = await saveAttachmentStorageConfig(db, input.data);
    await writeAudit(db, auth.session, "attachment_storage.configure", "attachmentStorage", "github-private-v1", { owner: saved.owner, repository: saved.repository, branch: saved.branch, basePath: saved.basePath, tokenLast4: saved.tokenLast4 });
    return ok(saved);
  } catch (error) {
    if (error instanceof Error && /GitHub|private repository|fine-grained/.test(error.message)) return fail(error.message, 422);
    return publicError(error);
  }
}
