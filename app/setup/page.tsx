import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { SetupForm } from "@/components/auth-forms";
import { readSession } from "@/lib/auth";

export const metadata = { title: "Workspace setup" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await readSession()) redirect("/dashboard");
  return <AuthShell><SetupForm /></AuthShell>;
}
