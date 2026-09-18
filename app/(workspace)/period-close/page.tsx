import { redirect } from "next/navigation";
import { PeriodCloseView } from "@/components/period-close-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Month-end close" };

export default async function PeriodClosePage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (!hasPermission(session.role, "accounting.read")) redirect("/dashboard");
  return <PeriodCloseView canClose={hasPermission(session.role, "accounting.write")} canReopen={hasPermission(session.role, "owner.control")} />;
}
