"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { ApiRequestError, apiRequest } from "@/components/ui";
import styles from "./owner-recovery-form.module.css";

type Grant = { businessName: string; expiresAt: string };

export function OwnerRecoveryForm() {
  const tokenRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<Record<string, string[]>>({});
  const [retry, setRetry] = useState(0);
  const [canRetry, setCanRetry] = useState(false);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (tokenRef.current === null) {
      tokenRef.current = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
      // Keep the secret in memory only, out of referrers, storage and copied URLs.
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
    const controller = new AbortController();
    async function inspect() {
      setChecking(true); setError(""); setCanRetry(false);
      if (!/^[a-f0-9]{64}$/i.test(tokenRef.current || "")) {
        setError("Open the complete private recovery link provided to you. This page cannot create an Owner without it.");
        setChecking(false); return;
      }
      try {
        const data = await apiRequest<Grant>("/api/owner-recovery", {
          method: "POST", body: JSON.stringify({ action: "INSPECT", token: tokenRef.current }), signal: controller.signal,
        });
        if (!controller.signal.aborted) setGrant(data);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Could not check the recovery link.");
        setCanRetry(reason instanceof ApiRequestError && (reason.status === 0 || reason.status >= 500));
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    }
    void inspect();
    return () => controller.abort();
  }, [retry]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || !grant || !tokenRef.current) return;
    const form = new FormData(event.currentTarget);
    setError(""); setIssues({});
    if (form.get("password") !== form.get("confirmPassword")) {
      setIssues({ confirmPassword: ["The passwords do not match."] }); return;
    }
    submittingRef.current = true; setBusy(true);
    try {
      const result = await apiRequest<{ redirectTo: string }>("/api/owner-recovery", {
        method: "POST", body: JSON.stringify({ action: "CLAIM", token: tokenRef.current,
          fullName: form.get("fullName"), username: form.get("username"), email: form.get("email"), password: form.get("password") }),
      });
      tokenRef.current = ""; setFinished(true);
      window.location.replace(result.redirectTo === "/dashboard" ? "/dashboard" : "/login?ownerRecovered=1");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not register the new Owner.");
      if (reason instanceof ApiRequestError) setIssues(reason.issues || {});
      setBusy(false); submittingRef.current = false;
    }
  }

  function fieldError(name: string) {
    return issues[name]?.length ? <small id={`recovery-${name}-error`} className={styles.fieldError}>{issues[name].join(" ")}</small> : null;
  }

  return <div className={styles.recovery}>
    <header className="auth-title"><span className="eyebrow">PRIVATE OWNER RECOVERY</span><h1>A new key.<br />The same ledger.</h1><p>Register your replacement Owner account. Your company, team and accounting history stay in place.</p></header>
    {checking ? <p className={styles.status} role="status"><LoaderCircle className="spin" size={20} />Checking your private link…</p> : null}
    {error ? <div className={styles.error} role="alert">{error}{grant ? <p>If registration completed but the connection was lost, <Link href="/login">sign in with the new details</Link>.</p> : null}</div> : null}
    {!checking && !grant ? <div className={styles.actions}>{canRetry ? <button className="button button-secondary" onClick={() => setRetry(value => value + 1)}>Check link again</button> : null}<Link className="button button-secondary" href="/login">Back to sign in</Link></div> : null}
    {!checking && grant ? <>
      <aside className={styles.preserved}><ShieldCheck size={23} /><div><strong>{grant.businessName}</strong><p>Existing users and all ledger records are preserved. This link can register one Owner only.</p><small>Link expires: {new Date(grant.expiresAt).toLocaleString()}</small></div></aside>
      <form className={styles.form} onSubmit={submit}>
        <fieldset disabled={busy || finished}>
          <label className="field"><span>Full name</span><input name="fullName" autoComplete="name" minLength={2} maxLength={100} required aria-invalid={Boolean(issues.fullName)} aria-describedby={issues.fullName ? "recovery-fullName-error" : undefined} />{fieldError("fullName")}</label>
          <label className="field"><span>Username</span><input name="username" autoComplete="username" minLength={3} maxLength={32} pattern="[a-zA-Z0-9._\-]+" autoCapitalize="none" spellCheck={false} required aria-invalid={Boolean(issues.username)} aria-describedby={issues.username ? "recovery-username-error" : "recovery-username-hint"} /><small id="recovery-username-hint" className={styles.hint}>3–32 letters, numbers, periods, underscores or hyphens.</small>{fieldError("username")}</label>
          <label className="field"><span>Email</span><input name="email" type="email" autoComplete="email" maxLength={160} required aria-invalid={Boolean(issues.email)} aria-describedby={issues.email ? "recovery-email-error" : undefined} />{fieldError("email")}</label>
          <label className="field"><span>New password</span><input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required aria-invalid={Boolean(issues.password)} aria-describedby={`recovery-password-hint${issues.password ? " recovery-password-error" : ""}`} /><small id="recovery-password-hint" className={styles.hint}>At least 12 characters with an uppercase letter, lowercase letter and number.</small>{fieldError("password")}</label>
          <label className="field"><span>Confirm password</span><input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required aria-invalid={Boolean(issues.confirmPassword)} aria-describedby={issues.confirmPassword ? "recovery-confirmPassword-error" : undefined} />{fieldError("confirmPassword")}</label>
          <button className="button button-primary button-large" type="submit">{busy ? <LoaderCircle className="spin" size={19} /> : <KeyRound size={19} />}{finished ? "Owner registered" : busy ? "Registering Owner…" : "Register new Owner"}<ArrowRight size={19} /></button>
        </fieldset>
      </form>
      <p className={styles.hint}>Keep this link private. Reopen the original link if you refresh this page before registration. Never share your Owner password.</p>
    </> : null}
  </div>;
}
