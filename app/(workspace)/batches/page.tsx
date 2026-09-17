import { redirect } from "next/navigation";
import { InventoryBatchesView } from "@/components/inventory-batches-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Batch & expiry control" };

export default async function InventoryBatchesPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (!hasPermission(session.role, "inventory.read")) redirect("/dashboard");
  return <InventoryBatchesView canWrite={hasPermission(session.role, "inventory.write")} />;
}
