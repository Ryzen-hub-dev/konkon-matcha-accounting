import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { hashPassword, normalizeIdentity } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canManageRole } from "@/lib/rbac";
import { USER_ROLES } from "@/lib/types";
import { serialise } from "@/lib/format";

export const runtime = "nodejs";

const userSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9._-]+$/),
  email: z.union([z.string().trim().email().max(160), z.literal("")]).default(""),
  role: z.enum(USER_ROLES).refine((role) => role !== "OWNER"),
  password: z.string().min(12).max(128)
    .regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
});

const updateSchema = z.object({
  id: z.string().length(24),
  role: z.enum(USER_ROLES).optional(),
  active: z.boolean().optional(),
}).refine((value) => value.role !== undefined || value.active !== undefined);

const projection = { passwordHash: 0, usernameNormalized: 0, emailNormalized: 0 };

export async function GET() {
  const auth = await authorize("team.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const [users, audit] = await Promise.all([
      db.collection("users").find({}, { projection }).sort({ role: 1, fullName: 1 }).limit(200).toArray(),
      db.collection("auditLogs").find({}).sort({ createdAt: -1 }).limit(20).toArray(),
    ]);
    return ok(serialise({ users, audit }));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("team.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = userSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the account details.", 422, input.error.flatten().fieldErrors);
    if (!canManageRole(auth.session.role, input.data.role)) return fail("You cannot create an account with this role.", 403);
    const db = await getDb();
    const now = new Date();
    const document = {
      fullName: input.data.fullName,
      username: input.data.username,
      usernameNormalized: normalizeIdentity(input.data.username),
      email: input.data.email,
      ...(input.data.email ? { emailNormalized: normalizeIdentity(input.data.email) } : {}),
      passwordHash: await hashPassword(input.data.password),
      role: input.data.role,
      active: true,
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("users").insertOne(document);
    await writeAudit(db, auth.session, "user.create", "user", result.insertedId.toHexString(), { username: document.username, role: document.role });
    const { passwordHash: _passwordHash, usernameNormalized: _usernameNormalized, emailNormalized: _emailNormalized, ...safeUser } = document;
    return created(serialise({ _id: result.insertedId, ...safeUser }));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("That username or email is already in use.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("team.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = updateSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the account update.", 422);
    if (input.data.id === auth.session.id && input.data.active === false) return fail("You cannot disable your own account.", 409);
    const db = await getDb();
    const target = await db.collection("users").findOne({ _id: new ObjectId(input.data.id) });
    if (!target) return fail("The account no longer exists.", 404);
    if (!canManageRole(auth.session.role, target.role) || (input.data.role && !canManageRole(auth.session.role, input.data.role))) {
      return fail("You cannot manage this account.", 403);
    }
    const changes = {
      ...(input.data.role ? { role: input.data.role } : {}),
      ...(input.data.active !== undefined ? { active: input.data.active } : {}),
      updatedAt: new Date(),
    };
    const user = await db.collection("users").findOneAndUpdate({ _id: target._id }, { $set: changes }, { returnDocument: "after", projection });
    await writeAudit(db, auth.session, "user.update", "user", input.data.id, changes);
    return ok(serialise(user));
  } catch (error) {
    return publicError(error);
  }
}
