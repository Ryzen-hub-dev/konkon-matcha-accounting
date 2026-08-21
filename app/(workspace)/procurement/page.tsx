import { redirect } from "next/navigation";
import { ProcurementView } from "@/components/procurement-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Purchasing & payables" };

export default async function ProcurementPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (!hasPermission(session.role, "purchasing.read")) redirect("/dashboard");
  return <ProcurementView
    canWrite={hasPermission(session.role, "purchasing.write")}
    canApprove={hasPermission(session.role, "purchasing.approve")}
    canPay={hasPermission(session.role, "payables.write")}
    currentUserId={session.id}
    allowSelfApproval={session.role === "OWNER"}
  />;
}
