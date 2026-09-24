import { redirect } from "next/navigation";
import { ConsolidationView } from "@/components/consolidation-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export default async function ConsolidationPage() {
  const session = await readSession();
  if (!session || !hasPermission(session.role, "reports.read")) redirect("/dashboard");
  return <ConsolidationView canWrite={hasPermission(session.role, "accounting.write")} />;
}
