import { redirect } from "next/navigation";
import { FixedAssetsView } from "@/components/fixed-assets-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Fixed assets" };

export default async function FixedAssetsPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (!hasPermission(session.role, "accounting.read")) redirect("/dashboard");
  return <FixedAssetsView canWrite={hasPermission(session.role, "accounting.write")} />;
}
