import { InventoryView } from "@/components/inventory-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
export const metadata = { title: "Inventory" };
export default async function InventoryPage() { const session = await readSession(); return <InventoryView canWrite={Boolean(session && hasPermission(session.role, "inventory.write"))} />; }
