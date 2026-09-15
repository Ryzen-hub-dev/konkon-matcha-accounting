import { redirect } from "next/navigation";
import { CountersView } from "@/components/counters-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Counters" };

export default async function CountersPage() {
  const session = await readSession();
  if (!session || !hasPermission(session.role, "counters.read")) redirect("/dashboard");
  return <CountersView canManage={hasPermission(session.role, "counters.manage")} />;
}
