"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Expand, LoaderCircle, LockKeyhole, Radio, ShieldCheck, Sprout, WifiOff } from "lucide-react";
import { apiRequest } from "@/components/ui";

type DisplayState = {
  phase: "WELCOME" | "PAYMENT" | "THANK_YOU";
  stateVersion: number;
  paymentName: string;
  provider: string;
  amount: number;
  currency: string;
  qrPayload: string;
  amountLocked: boolean;
  expiresAt: string;
};

const WELCOME_STATE: DisplayState = {
  phase: "WELCOME", stateVersion: 0, paymentName: "", provider: "", amount: 0, currency: "", qrPayload: "", amountLocked: false, expiresAt: "",
};

export function PaymentDisplay({ token }: { token: string }) {
  const [display, setDisplay] = useState<DisplayState>(WELCOME_STATE);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [connection, setConnection] = useState<"CONNECTING" | "LIVE" | "ERROR">("CONNECTING");
  const [error, setError] = useState("");
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      let failed = false;
      try {
        const next = await apiRequest<DisplayState>("/api/payment-display", { method: "POST", body: JSON.stringify({ token, action: "POLL" }) });
        if (cancelled) return;
        setDisplay(next);
        setConnection("LIVE");
        setError("");
      } catch (reason) {
        if (cancelled) return;
        failed = true;
        setConnection("ERROR");
        setError(reason instanceof Error ? reason.message : "This payment screen could not reach the register.");
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, failed ? 2_500 : 1_200);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl("");
    if (display.phase !== "PAYMENT" || !display.qrPayload) return;
    void QRCode.toDataURL(display.qrPayload, {
      scale: 12, margin: 8, errorCorrectionLevel: "M", color: { dark: "#111b15", light: "#ffffff" },
    }).then((url) => { if (!cancelled) setQrDataUrl(url); }).catch(() => { if (!cancelled) setQrDataUrl(""); });
    return () => { cancelled = true; };
  }, [display.phase, display.qrPayload]);

  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  const amount = useMemo(() => {
    if (!display.currency) return "";
    try { return new Intl.NumberFormat("en-MY", { style: "currency", currency: display.currency }).format(display.amount); }
    catch { return `${display.currency} ${display.amount.toFixed(2)}`; }
  }, [display.amount, display.currency]);

  const enterFullscreen = useCallback(async () => {
    try { await document.documentElement.requestFullscreen(); }
    catch { setError("Fullscreen was blocked. Use the browser menu to add this page to the home screen."); }
  }, []);

  return <main className={`payment-display-page phase-${display.phase.toLowerCase()}`}>
    <header className="payment-display-header">
      <div><Sprout /><span><strong>KŌN-KŌN</strong><small>CUSTOMER PAYMENT DISPLAY</small></span></div>
      <p className={`payment-display-signal ${connection.toLowerCase()}`}><Radio />{connection === "LIVE" ? "REGISTER LIVE" : connection === "CONNECTING" ? "CONNECTING" : "RECONNECTING"}</p>
    </header>

    <section className="payment-display-stage" aria-live="polite">
      {display.phase === "WELCOME" ? <div className="payment-display-welcome">
        <div className="display-whisk-rings" aria-hidden="true"><i /><i /><i /></div>
        <span>THE COUNTER IS READY</span>
        <h1>Welcome</h1>
        <p>Your payment code will appear here when the cashier selects a supported wallet.</p>
      </div> : display.phase === "THANK_YOU" ? <div className="payment-display-thanks">
        <CheckCircle2 />
        <span>ORDER RECORDED</span>
        <h1>Thank You</h1>
        <p>Please collect your receipt and purchases from the counter.</p>
      </div> : <div className="payment-display-payment">
        <div className="payment-display-copy">
          <span>{display.paymentName}</span>
          <h1>{amount}</h1>
          <p>{display.amountLocked ? "The exact POS amount is embedded in this DuitNow QR." : "Scan this recipient QR and confirm the exact amount in your payment app."}</p>
          <div className={display.amountLocked ? "amount-lock-badge locked" : "amount-lock-badge"}>{display.amountLocked ? <LockKeyhole /> : <ShieldCheck />}<span><strong>{display.amountLocked ? "AMOUNT LOCKED" : "AMOUNT SHOWN SEPARATELY"}</strong><small>{display.amountLocked ? "CRC recalculated · recipient unchanged" : "Cashier must check the receiving app"}</small></span></div>
        </div>
        <div className="payment-display-qr-shell">
          <div className="payment-display-qr">{qrDataUrl ? <img src={qrDataUrl} alt={`${display.paymentName} payment QR for ${amount}`} /> : <LoaderCircle className="spin" />}</div>
          <span>SCAN WITH A SUPPORTED BANK OR EWALLET</span>
        </div>
      </div>}
    </section>

    <footer className="payment-display-footer">
      <p><ShieldCheck /><span><strong>Wait for cashier confirmation</strong><small>This screen and the payer’s animation are not proof that money reached the receiver.</small></span></p>
      {!fullscreen ? <button type="button" onClick={() => void enterFullscreen()}><Expand />Full screen</button> : null}
    </footer>
    {error ? <div className="payment-display-error"><WifiOff />{error}</div> : null}
  </main>;
}
