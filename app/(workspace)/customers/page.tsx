import { redirect } from "next/navigation";
import { CustomerAccountsView } from "@/components/customer-accounts-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Customer accounts" };

export default async function CustomerAccountsPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (!hasPermission(session.role, "invoices.read")) redirect("/dashboard");
  return <CustomerAccountsView canWrite={hasPermission(session.role, "invoices.write")} />;
}
