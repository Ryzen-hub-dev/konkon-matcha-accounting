import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { readSession } from "@/lib/auth";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  const db = await getDb();
  const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
  return <AppShell user={{ id: session.id, username: session.username, fullName: session.fullName, role: session.role }} business={business}>{children}</AppShell>;
}
