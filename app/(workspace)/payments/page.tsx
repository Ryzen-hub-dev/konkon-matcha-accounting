import { redirect } from "next/navigation";
import { PaymentMethodsView } from "@/components/payment-methods-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Payment methods" };

export default async function PaymentMethodsPage() {
  const session = await readSession();
  if (!session || !hasPermission(session.role, "payments.read")) redirect("/dashboard");
  return <PaymentMethodsView canManage={hasPermission(session.role, "payments.manage")} />;
}
