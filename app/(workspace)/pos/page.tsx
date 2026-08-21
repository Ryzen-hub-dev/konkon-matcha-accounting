import { PosView } from "@/components/pos-view";
import { readSession } from "@/lib/auth";
export const metadata = { title: "Point of sale" };
export default async function PosPage() {
  const session = await readSession();
  const manager = Boolean(session && ["OWNER", "ADMIN", "MANAGER"].includes(session.role));
  return <PosView userId={session?.id || "unknown"} canManageTemplates={manager} canManualDiscount={manager} />;
}
