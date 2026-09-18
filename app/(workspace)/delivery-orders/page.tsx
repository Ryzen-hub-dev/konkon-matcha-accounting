import { redirect } from "next/navigation";
import { DeliveryOrdersView } from "@/components/delivery-orders-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Delivery orders" };

export default async function DeliveryOrdersPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (!hasPermission(session.role, "invoices.read")) redirect("/dashboard");
  return <DeliveryOrdersView canWrite={hasPermission(session.role, "invoices.write")} />;
}
