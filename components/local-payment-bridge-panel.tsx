"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Cable, CheckCircle2, CircleAlert, Database, LockKeyhole, RefreshCw, ShieldCheck, Smartphone, Unplug } from "lucide-react";
import { apiRequest } from "@/components/ui";
import type { SanitizedLocalPaymentEvent } from "@/lib/local-payment-bridge";

type StoredEvent = Omit<SanitizedLocalPaymentEvent, "paidAt"> & {
  _id: string;
  paidAt: string;
  status: string;
  candidateIntentNo?: string;
  candidateCount?: number;
  createdAt: string;
};

type BridgeEvent = Omit<SanitizedLocalPaymentEvent, "paidAt"> & { paidAt: string; sequence: number };
type LocalResponse<T> = { ok: boolean; data?: T; error?: string };

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:17321";
const TOKEN_KEY = "konkon-local-payment-bridge-token";
const URL_KEY = "konkon-local-payment-bridge-url";

function validLoopbackUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password && url.pathname === "/";
  } catch {
    return false;
  }
}

async function localRequest<T>(baseUrl: string, path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, mode: "cors", cache: "no-store" });
  const body = await response.json().catch(() => null) as LocalResponse<T> | null;
  if (!response.ok || body?.ok !== true || !body.data) throw new Error(body?.error || `Local listener returned ${response.status}.`);
  return body.data;
}

function eventAmount(event: StoredEvent) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: event.currency }).format(event.amount); }
  catch { return `${event.currency} ${event.amount.toFixed(2)}`; }
}

export function LocalPaymentBridgePanel() {
  const [bridgeUrl, setBridgeUrl] = useState(DEFAULT_BRIDGE_URL);
  const [pairCode, setPairCode] = useState("");
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [usbReady, setUsbReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<StoredEvent[]>([]);
  const [lastImportedAt, setLastImportedAt] = useState<Date | null>(null);
  const cursorRef = useRef(0);

  const loadRecent = useCallback(async () => {
    try { setRecent(await apiRequest<StoredEvent[]>("/api/local-payment-events")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not read imported payment evidence."); }
  }, []);

  useEffect(() => {
    setBridgeUrl(sessionStorage.getItem(URL_KEY) || DEFAULT_BRIDGE_URL);
    const rememberedToken = sessionStorage.getItem(TOKEN_KEY) || "";
    if (rememberedToken) { setToken(rememberedToken); setConnected(true); }
    void loadRecent();
  }, [loadRecent]);

  const connect = useCallback(async () => {
    setError("");
    if (!validLoopbackUrl(bridgeUrl)) return setError("The listener must use a loopback URL such as http://127.0.0.1:17321.");
    if (!/^\d{6}$/.test(pairCode)) return setError("Enter the six-digit pairing code shown in the local terminal.");
    setBusy(true);
    try {
      const result = await localRequest<{ token: string; cursor: number; usbReady: boolean }>(bridgeUrl, "/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairCode }),
      });
      sessionStorage.setItem(URL_KEY, bridgeUrl);
      sessionStorage.setItem(TOKEN_KEY, result.token);
      cursorRef.current = result.cursor;
      setToken(result.token);
      setConnected(true);
      setUsbReady(result.usbReady);
      setPairCode("");
    } catch (reason) {
      setConnected(false);
      setError(reason instanceof Error ? reason.message : "The local payment listener could not be paired.");
    } finally { setBusy(false); }
  }, [bridgeUrl, pairCode]);

  const disconnect = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken("");
    setConnected(false);
    setUsbReady(false);
    cursorRef.current = 0;
  }, []);

  useEffect(() => {
    if (!connected || !token || !validLoopbackUrl(bridgeUrl)) return;
    let stopped = false;
    let timer = 0;

    async function poll() {
      try {
      const result = await localRequest<{ events: BridgeEvent[]; cursor: number; usbReady: boolean }>(bridgeUrl, `/events?after=${cursorRef.current}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        for (const event of result.events) {
          const { sequence: _sequence, ...sanitised } = event;
          await apiRequest<StoredEvent>("/api/local-payment-events", { method: "POST", body: JSON.stringify(sanitised) });
          setLastImportedAt(new Date());
        }
        cursorRef.current = result.cursor;
        setUsbReady(result.usbReady);
        setError("");
        if (result.events.length) await loadRecent();
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : "The local listener connection was interrupted.");
      }
      if (!stopped) timer = window.setTimeout(poll, 1_200);
    }

    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [bridgeUrl, connected, loadRecent, token]);

  return <section className="local-payment-bridge" aria-labelledby="local-payment-bridge-title">
    <header className="local-bridge-heading">
      <div><span className="eyebrow">PRIVATE USB RAIL · DUAL ADAPTER</span><h2 id="local-payment-bridge-title">Local payment listener</h2><p>Receive payment-only Webhooks from SmsForwarder or notify-me without turning the website into an SMS reader.</p></div>
      <span className={`local-bridge-state ${connected ? "connected" : "offline"}`}>{connected ? <CheckCircle2 /> : <Unplug />}{connected ? "Listening locally" : "Not connected"}</span>
    </header>

    <div className="local-privacy-rail" aria-label="Private payment notification data path">
      <article><Smartphone /><span><b>Android receiver</b><small>USB cable · payment senders only</small></span></article>
      <i><Cable /></i>
      <article className="privacy-gate"><LockKeyhole /><span><b>Privacy gate</b><small>OTP and raw text are discarded</small></span></article>
      <i><ShieldCheck /></i>
      <article><Database /><span><b>MongoDB evidence</b><small>Amount, currency, time and reference only</small></span></article>
    </div>

    <div className="local-bridge-workbench">
      <div className="local-bridge-pairing">
        <div className="local-bridge-instruction"><b>1</b><span><strong>Start the listener</strong><small>Run <code>npm run bridge:payments</code> on this computer, then connect and authorise the Android phone over USB.</small></span></div>
        <div className="local-bridge-instruction"><b>2</b><span><strong>Configure one or both adapters</strong><small>Use the signed SmsForwarder form and/or notify-me Bearer header printed by the listener. Dual delivery is deduplicated; never create a “forward all messages” rule.</small></span></div>
        <div className="local-bridge-instruction"><b>3</b><span><strong>Pair this browser</strong><small>The browser token stays in this tab session and can only connect to localhost.</small></span></div>
        <div className="local-bridge-fields"><label className="field"><span>Local listener</span><input value={bridgeUrl} disabled={connected} onChange={(event) => setBridgeUrl(event.target.value)} inputMode="url" /></label><label className="field"><span>Pairing code</span><input value={pairCode} disabled={connected} onChange={(event) => setPairCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="000000" /></label></div>
        <div className="local-bridge-actions">{connected ? <button className="button button-secondary" onClick={disconnect}><Unplug />Disconnect</button> : <button className="button button-primary" disabled={busy} onClick={() => void connect()}><Cable />{busy ? "Pairing…" : "Pair local listener"}</button>}<button className="button button-secondary" onClick={() => void loadRecent()}><RefreshCw />Refresh evidence</button></div>
        <p className="local-bridge-assurance"><ShieldCheck /><span><strong>The cloud never receives the original message.</strong><small>Local notifications are supporting evidence only. They remain REQUIRES REVIEW and never mark a sale paid by themselves. SmsForwarder is evaluation-only unless its owner grants a commercial licence.</small></span></p>
        {error ? <p className="local-bridge-error"><CircleAlert />{error}</p> : null}
      </div>

      <aside className="local-bridge-ledger">
        <header><div><span>REVIEW QUEUE</span><strong>{recent.length} recent event{recent.length === 1 ? "" : "s"}</strong></div><small>{connected ? usbReady ? "USB reverse verified" : "Listener paired · verify USB" : "Pair to import new evidence"}</small></header>
        {recent.length ? <div>{recent.slice(0, 6).map((event) => <article key={event._id}><span className="local-event-provider">{event.provider}</span><div><strong>{eventAmount(event)}</strong><small>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.paidAt))}{event.candidateIntentNo ? ` · candidate ${event.candidateIntentNo}` : " · no unique intent match"}</small></div><span className="local-event-review">Review</span></article>)}</div> : <div className="local-bridge-empty"><Database /><strong>No sanitised evidence yet</strong><span>Incoming payment notifications will appear here without their original message text.</span></div>}
        {lastImportedAt ? <footer>Last MongoDB import {lastImportedAt.toLocaleTimeString()}</footer> : null}
      </aside>
    </div>
  </section>;
}
