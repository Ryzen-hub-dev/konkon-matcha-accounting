import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";

export const runtime = "nodejs";

const memberSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(7).max(24).regex(/^[0-9+() -]+$/),
  email: z.union([z.string().trim().email().max(160), z.literal("")]).default(""),
});

export async function GET() {
  const auth = await authorize("members.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const members = await db.collection("members").find({ active: { $ne: false } }).sort({ createdAt: -1 }).limit(500).toArray();
    return ok(serialise(members));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("members.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = memberSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the member details.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const now = new Date();
    const document = {
      memberNo: makeDocumentNo("MEM"),
      ...input.data,
      points: 0,
      lifetimeSpend: 0,
      active: true,
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("members").insertOne(document);
    await writeAudit(db, auth.session, "member.create", "member", result.insertedId.toHexString(), { memberNo: document.memberNo });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("A member with this phone number already exists.", 409);
    return publicError(error);
  }
}
