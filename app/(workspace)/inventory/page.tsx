import { InventoryView } from "@/components/inventory-view";
import { readSession } from "@/lib/auth";
export const metadata = { title: "Inventory" };
export default async function InventoryPage() { const session = await readSession(); return <InventoryView canWrite={Boolean(session && ["OWNER", "ADMIN", "MANAGER"].includes(session.role))} />; }
