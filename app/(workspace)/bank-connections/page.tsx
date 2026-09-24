import { redirect } from "next/navigation";
import { BankConnectionsView } from "@/components/bank-connections-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Live bank feeds" };

export default async function BankConnectionsPage() {
  const session = await readSession();
  if (!session || !hasPermission(session.role, "accounting.read"))
    redirect("/dashboard");
  return <BankConnectionsView />;
}
