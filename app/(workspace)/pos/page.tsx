import { PosView } from "@/components/pos-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
export const metadata = { title: "Point of sale" };
export default async function PosPage() {
  const session = await readSession();
  return <PosView userId={session?.id || "unknown"} canManageTemplates={Boolean(session && hasPermission(session.role, "receipts.manage"))} canManualDiscount={Boolean(session && hasPermission(session.role, "coupons.manage"))} />;
}
