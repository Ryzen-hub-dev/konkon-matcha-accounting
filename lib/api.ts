import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { readSession } from "@/lib/auth";
import { hasPermission, type Permission } from "@/lib/rbac";
import { getDb } from "@/lib/db";
import type { UserRole } from "@/lib/types";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, { status: 200, ...init });
}

export function created<T>(data: T) {
  return NextResponse.json({ ok: true, data }, { status: 201 });
}

export function fail(error: string, status = 400, issues?: Record<string, string[]>) {
  return NextResponse.json({ ok: false, error, ...(issues ? { issues } : {}) }, { status });
}

export async function authorize(permission: Permission) {
  const session = await readSession();
  if (!session) return { error: fail("Your session has expired. Sign in again.", 401) } as const;
  if (!ObjectId.isValid(session.id)) return { error: fail("Your session is invalid. Sign in again.", 401) } as const;
  try {
    const db = await getDb();
    const user = await db.collection("users").findOne(
      { _id: new ObjectId(session.id), active: true },
      { projection: { role: 1, username: 1, fullName: 1 } },
    );
    if (!user) return { error: fail("This account is no longer active.", 401) } as const;
    session.role = user.role as UserRole;
    session.username = String(user.username);
    session.fullName = String(user.fullName);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") console.error(error);
    return { error: fail("The account service is temporarily unavailable.", 503) } as const;
  }
  if (!hasPermission(session.role, permission)) {
    return { error: fail("You do not have permission to perform this action.", 403) } as const;
  }
  return { session } as const;
}

export function publicError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const name = error instanceof Error ? error.name : "";
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (message === "MONGODB_URI is not configured.") {
    return fail("The database is not configured on this deployment.", 503);
  }
  if (name === "MongoParseError") {
    return fail("The database connection string is invalid.", 503);
  }
  if (code === "18" || /authentication failed|bad auth/i.test(message)) {
    return fail("The database rejected its credentials.", 503);
  }
  if (name === "MongoServerSelectionError" || name === "MongoNetworkError") {
    return fail("The database cluster could not be reached. Check the MongoDB Atlas IP access list.", 503);
  }
  if (process.env.NODE_ENV !== "production") console.error(error);
  return fail("The request could not be completed. Please try again.", 500);
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!origin || !host) return process.env.NODE_ENV !== "production";
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
