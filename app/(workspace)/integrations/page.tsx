import { redirect } from "next/navigation";
import { IntegrationsView } from "@/components/integrations-view";
import { readSession } from "@/lib/auth";

export const metadata = { title: "Messaging integrations" };

export default async function IntegrationsPage() {
  const session = await readSession();
  if (!session || session.role !== "OWNER") redirect("/dashboard");
  return <IntegrationsView />;
}
