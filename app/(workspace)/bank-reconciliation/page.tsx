import { redirect } from "next/navigation";
import { BankReconciliationView } from "@/components/bank-reconciliation-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Bank reconciliation" };

export default async function BankReconciliationPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (!hasPermission(session.role, "accounting.read")) redirect("/dashboard");
  return <BankReconciliationView canWrite={hasPermission(session.role, "accounting.write")} />;
}
