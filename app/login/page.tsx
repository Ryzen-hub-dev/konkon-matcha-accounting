import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/auth-forms";
import { readSession } from "@/lib/auth";
import { readPublicBranding } from "@/lib/public-branding";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await readSession()) redirect("/dashboard");
  const branding = await readPublicBranding();
  return <AuthShell businessName={branding.businessName} logoDataUrl={branding.workspaceLogoDataUrl}><LoginForm /></AuthShell>;
}
