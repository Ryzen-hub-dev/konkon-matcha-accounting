"use client";

import QRCode from "qrcode";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, ExternalLink, Link2, MonitorSmartphone, Plus, Radio, Unplug } from "lucide-react";
import { apiRequest, Modal } from "@/components/ui";
import type { PaymentMethodRecord } from "@/lib/payment-methods";

type DisplaySession = {
  _id: string;
  label: string;
  phase: "WELCOME" | "PAYMENT" | "THANK_YOU";
  stateVersion: number;
  amountLocked?: boolean;
  connectedAt?: string;
  lastSeenAt?: string;
  expiresAt: string;
};

type BridgeState = "OFFLINE" | "SYNCING" | "LIVE" | "ERROR";

export function PaymentDisplayBridge({
  userId,
  paymentMethod,
  amount,
  currency,
  displayRequested,
  completedAt,
  onFeedback,
}: {
  userId: string;
  paymentMethod?: PaymentMethodRecord;
  amount: number;
  currency: string;
  displayRequested: boolean;
  completedAt: number;
  onFeedback?: (message: string, tone?: "success" | "error") => void;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<DisplaySession[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [issuedUrl, setIssuedUrl] = useState("");
  const [issuedQr, setIssuedQr] = useState("");
  const [bridgeState, setBridgeState] = useState<BridgeState>("OFFLINE");
  const [busy, setBusy] = useState(false);
  const [holdUntil, setHoldUntil] = useState(0);
  const selectedIdRef = useRef("");
  const lastSignatureRef = useRef("");
  const completionRef = useRef(0);
  const holdUntilRef = useRef(0);
  const storageKey = useMemo(() => `konkon:payment-display:${userId}`, [userId]);

  const feedback = useCallback((message: string, tone: "success" | "error" = "success") => onFeedback?.(message, tone), [onFeedback]);

  const selectSession = useCallback((id: string) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    if (id) window.localStorage.setItem(storageKey, id);
    else window.localStorage.removeItem(storageKey);
    lastSignatureRef.current = "";
  }, [storageKey]);

  const loadSessions = useCallback(async (preferredId?: string) => {
    try {
      const result = await apiRequest<{ sessions: DisplaySession[] }>("/api/payment-display-sessions");
      setSessions(result.sessions);
      const stored = preferredId || selectedIdRef.current || window.localStorage.getItem(storageKey) || "";
      const selected = result.sessions.find((session) => session._id === stored) || result.sessions[0];
      if (selected?._id !== selectedIdRef.current) selectSession(selected?._id || "");
    } catch (reason) {
      setBridgeState("ERROR");
      feedback(reason instanceof Error ? reason.message : "Could not load customer payment screens.", "error");
    }
  }, [feedback, selectSession, storageKey]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (selectedIdRef.current || open) void loadSessions(); }, 4_000);
    return () => window.clearInterval(timer);
  }, [loadSessions, open]);

  useEffect(() => {
    let cancelled = false;
    if (!issuedUrl) { setIssuedQr(""); return; }
    void QRCode.toDataURL(issuedUrl, { errorCorrectionLevel: "H", margin: 2, width: 300 })
      .then((url) => { if (!cancelled) setIssuedQr(url); }).catch(() => { if (!cancelled) setIssuedQr(""); });
    return () => { cancelled = true; };
  }, [issuedUrl]);

  useEffect(() => {
    if (!selectedId || !completedAt || completedAt === completionRef.current) return;
    completionRef.current = completedAt;
    const until = Date.now() + 5_000;
    holdUntilRef.current = until;
    setHoldUntil(until);
    lastSignatureRef.current = "";
    setBridgeState("SYNCING");
    void apiRequest<DisplaySession>("/api/payment-display-sessions", {
      method: "PATCH", body: JSON.stringify({ id: selectedId, action: "THANK_YOU" }),
    }).then((session) => {
      setSessions((current) => current.map((item) => item._id === session._id ? session : item));
      setBridgeState("LIVE");
    }).catch((reason) => {
      setBridgeState("ERROR");
      feedback(reason instanceof Error ? reason.message : "The customer screen could not show Thank You.", "error");
    });
  }, [completedAt, feedback, selectedId]);

  useEffect(() => {
    if (!holdUntil) return;
    const remaining = holdUntil - Date.now();
    if (remaining <= 0) { holdUntilRef.current = 0; lastSignatureRef.current = ""; setHoldUntil(0); return; }
    const timer = window.setTimeout(() => { holdUntilRef.current = 0; lastSignatureRef.current = ""; setHoldUntil(0); }, remaining + 100);
    return () => window.clearTimeout(timer);
  }, [holdUntil]);

  useEffect(() => {
    if (!selectedId || holdUntilRef.current > Date.now()) return;
    const canDisplay = displayRequested && paymentMethod?.verificationMode === "STATIC_QR" && Boolean(paymentMethod.qrPayload) && amount > 0;
    const body = canDisplay
      ? { id: selectedId, action: "DISPLAY", paymentMethodCode: paymentMethod.code, amount, currency }
      : { id: selectedId, action: "WELCOME" };
    const requestBody = JSON.stringify(body);
    const signature = JSON.stringify({ ...body, qrRevision: canDisplay ? paymentMethod.qrPayload : "" });
    if (signature === lastSignatureRef.current) return;
    const timer = window.setTimeout(() => {
      setBridgeState("SYNCING");
      void apiRequest<DisplaySession>("/api/payment-display-sessions", { method: "PATCH", body: requestBody })
        .then((session) => {
          lastSignatureRef.current = signature;
          setSessions((current) => current.map((item) => item._id === session._id ? session : item));
          setBridgeState("LIVE");
        }).catch((reason) => {
          lastSignatureRef.current = signature;
          setBridgeState("ERROR");
          feedback(reason instanceof Error ? reason.message : "The POS amount could not reach the customer screen.", "error");
        });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [amount, currency, displayRequested, feedback, holdUntil, paymentMethod, selectedId]);

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const label = String(new FormData(event.currentTarget).get("label") || "Customer payment screen");
    try {
      const result = await apiRequest<{ session: DisplaySession; url: string }>("/api/payment-display-sessions", { method: "POST", body: JSON.stringify({ label }) });
      setIssuedUrl(result.url);
      await loadSessions(result.session._id);
      feedback("24-hour customer payment-screen pass issued and selected.");
    } catch (reason) { feedback(reason instanceof Error ? reason.message : "Could not link the customer payment screen.", "error"); }
    finally { setBusy(false); }
  }

  async function revokeSession(session: DisplaySession) {
    try {
      await apiRequest("/api/payment-display-sessions", { method: "DELETE", body: JSON.stringify({ id: session._id }) });
      if (selectedIdRef.current === session._id) selectSession("");
      setIssuedUrl("");
      await loadSessions();
      feedback("Customer payment-screen pass revoked immediately.");
    } catch (reason) { feedback(reason instanceof Error ? reason.message : "Could not revoke the payment-screen pass.", "error"); }
  }

  const selected = sessions.find((session) => session._id === selectedId);
  const connected = Boolean(selected?.lastSeenAt && Date.now() - new Date(selected.lastSeenAt).getTime() < 12_000);

  return <>
    <section className={`payment-display-bridge bridge-${bridgeState.toLowerCase()}`}>
      <div className="payment-display-bridge-mark"><MonitorSmartphone /><i /></div>
      <div><span>CUSTOMER PAYMENT SCREEN</span><strong>{selected ? selected.label : "No display linked"}</strong><small>{selected ? `${connected ? "Phone online" : "Waiting for phone"} · ${selected.phase === "PAYMENT" ? selected.amountLocked ? "fixed POS amount live" : "recipient QR live" : selected.phase.toLowerCase()}` : "Separate from the online barcode scanner"}</small></div>
      <p><Radio />{bridgeState === "LIVE" ? "SYNCED" : bridgeState === "SYNCING" ? "UPDATING" : bridgeState === "ERROR" ? "CHECK LINK" : "READY"}</p>
      <button type="button" className="button button-secondary" onClick={() => { setOpen(true); void loadSessions(); }}><MonitorSmartphone />{selected ? "Manage payment screen" : "Link payment screen"}</button>
    </section>

    <Modal open={open} onClose={() => setOpen(false)} title="Link a customer payment screen" kicker="SEPARATE DISPLAY PASS">
      <div className="payment-screen-link-panel">
        <div className="payment-screen-link-intro"><MonitorSmartphone /><div><strong>A second phone becomes the customer-facing display</strong><p>It receives only Welcome, Thank You, payment name, currency, amount and the recipient QR. Products, members, stock, reports and account access are never exposed.</p></div></div>
        <form onSubmit={createSession}><label className="field"><span>Display label</span><input name="label" defaultValue="Counter customer screen" minLength={2} maxLength={60} required /></label><button className="button button-primary" disabled={busy}><Plus />{busy ? "Issuing…" : "Issue 24-hour display pass"}</button></form>
        {issuedUrl ? <div className="issued-payment-screen">{issuedQr ? <img src={issuedQr} alt="QR code that links a customer payment screen" /> : null}<div><span>SCAN ON THE SECOND PHONE</span><code>{issuedUrl}</code><p><a className="button button-secondary" href={issuedUrl} target="_blank" rel="noreferrer"><ExternalLink />Open display</a><button type="button" className="button button-secondary" onClick={() => void navigator.clipboard.writeText(issuedUrl).then(() => feedback("Payment-screen link copied.")).catch(() => feedback("The browser blocked clipboard access. Open the display link instead.", "error"))}><Copy />Copy link</button></p></div></div> : null}
        <div className="payment-screen-session-list">{sessions.length ? sessions.map((session) => <article key={session._id} className={selectedId === session._id ? "selected" : ""}><div><strong>{session.label}</strong><span>{session.lastSeenAt ? "Phone connected" : "Waiting for phone"} · expires {new Intl.DateTimeFormat("en-SG", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(session.expiresAt))}</span></div><button type="button" className="button button-secondary" disabled={selectedId === session._id} onClick={() => { selectSession(session._id); setOpen(false); }}>{selectedId === session._id ? "Selected" : "Use here"}</button><button type="button" className="icon-button danger" title="Revoke display pass" onClick={() => void revokeSession(session)}><Unplug /></button></article>) : <p>No active customer payment screens.</p>}</div>
        <div className="payment-screen-privacy"><Link2 /><span><strong>This link cannot control the POS.</strong><small>It is read-only, expires after 24 hours and can be revoked immediately from this panel.</small></span></div>
      </div>
    </Modal>
  </>;
}
