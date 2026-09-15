import { ReceiptsView } from "@/components/receipts-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
export const metadata = { title: "Receipts" };
export default async function ReceiptsPage() {
  const session = await readSession();
  return <ReceiptsView canSell={Boolean(session && hasPermission(session.role, "pos.sell"))} />;
}
