import { redirect } from "next/navigation";
import { OnlineOrdersView } from "@/components/online-orders-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Online orders" };

export default async function CommercePage() {
  const session = await readSession();
  if (!session || !hasPermission(session.role, "commerce.read"))
    redirect("/dashboard");
  return <OnlineOrdersView />;
}
