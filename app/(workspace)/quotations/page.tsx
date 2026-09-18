import { redirect } from "next/navigation";
import { QuotationsView } from "@/components/quotations-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Quotations" };

export default async function QuotationsPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (!hasPermission(session.role, "invoices.read")) redirect("/dashboard");
  return <QuotationsView canWrite={hasPermission(session.role, "invoices.write")} />;
}
