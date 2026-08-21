import { CouponsView } from "@/components/coupons-view";
import { readSession } from "@/lib/auth";

export const metadata = { title: "Coupons & vouchers" };

export default async function CouponsPage() {
  const session = await readSession();
  return <CouponsView canManage={Boolean(session && ["OWNER", "ADMIN", "MANAGER"].includes(session.role))} />;
}
