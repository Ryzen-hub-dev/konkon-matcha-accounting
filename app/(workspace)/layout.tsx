import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { readSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  return <AppShell user={{ id: session.id, username: session.username, fullName: session.fullName, role: session.role }}>{children}</AppShell>;
}
