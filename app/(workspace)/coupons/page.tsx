import { CouponsView } from "@/components/coupons-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Coupons & vouchers" };

export default async function CouponsPage() {
  const session = await readSession();
  return <CouponsView canManage={Boolean(session && hasPermission(session.role, "coupons.manage"))} />;
}
