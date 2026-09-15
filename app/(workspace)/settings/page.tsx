import { SettingsView } from "@/components/settings-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
export const metadata = { title: "Workspace settings" };
export default async function SettingsPage() { const session = await readSession(); return <SettingsView isOwner={Boolean(session && hasPermission(session.role, "owner.control"))} />; }
