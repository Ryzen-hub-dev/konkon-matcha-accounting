"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiRequest, Notice } from "@/components/ui";

export function ForcedPasswordForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    if (data.get("newPassword") !== data.get("confirmPassword")) { setError("The new passwords do not match."); setBusy(false); return; }
    try {
      await apiRequest("/api/profile", { method: "PATCH", body: JSON.stringify({ currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword") }) });
      router.replace("/dashboard"); router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not change the password."); setBusy(false); }
  }
  return <form className="auth-form" onSubmit={submit}><div className="auth-title"><span className="eyebrow">SECURITY CHECKPOINT</span><h1>Make this account<br />yours.</h1><p>The temporary password can only open this page. Choose a private password before entering the ledger.</p></div>{error ? <Notice message={error} tone="error" /> : null}<div className="security-note"><ShieldCheck /><div><strong>Other sessions are revoked</strong><p>Saving a new password rotates your account session version everywhere.</p></div></div><label className="field"><span>Temporary password</span><input name="currentPassword" type="password" autoComplete="current-password" required autoFocus /></label><label className="field"><span>New password</span><input name="newPassword" type="password" minLength={12} autoComplete="new-password" required /></label><label className="field"><span>Confirm new password</span><input name="confirmPassword" type="password" minLength={12} autoComplete="new-password" required /></label><button className="button button-primary button-large" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <KeyRound />}{busy ? "Securing account…" : "Set password & continue"}<ArrowRight /></button></form>;
}
