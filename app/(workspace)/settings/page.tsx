import { SettingsView } from "@/components/settings-view";
import { readSession } from "@/lib/auth";
export const metadata = { title: "Workspace settings" };
export default async function SettingsPage() { const session = await readSession(); return <SettingsView isOwner={session?.role === "OWNER"} />; }
