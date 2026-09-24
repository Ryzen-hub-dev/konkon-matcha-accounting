import { redirect } from "next/navigation";
import { PayrollView } from "@/components/payroll-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Payroll" };

export default async function PayrollPage() {
  const session = await readSession();
  if (!session || !hasPermission(session.role, "payroll.read")) redirect("/dashboard");
  return <PayrollView />;
}
