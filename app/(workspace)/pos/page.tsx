import { PosView } from "@/components/pos-view";
import { readSession } from "@/lib/auth";
export const metadata = { title: "Point of sale" };
export default async function PosPage() {
  const session = await readSession();
  return <PosView canManageTemplates={Boolean(session && ["OWNER", "ADMIN", "MANAGER"].includes(session.role))} />;
}
