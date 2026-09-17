import { redirect } from "next/navigation";
import { StockTransfersView } from "@/components/stock-transfers-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Stock transfers" };

export default async function StockTransfersPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (!hasPermission(session.role, "inventory.read")) redirect("/dashboard");
  return <StockTransfersView canWrite={hasPermission(session.role, "inventory.write")} />;
}
