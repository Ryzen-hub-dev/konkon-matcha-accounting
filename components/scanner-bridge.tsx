"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Barcode, Copy, Link2, Plus, Radio, ScanLine, Smartphone, Unplug } from "lucide-react";
import { apiRequest, Modal } from "@/components/ui";
import { selectScannerSession } from "@/lib/scanner-routing";

type ScannerSession = { _id: string; label: string; purpose: "POS" | "INVENTORY"; expiresAt: string; connectedAt?: string; lastUsedAt?: string };
type ScanEvent = { _id: string; code: string; createdAt: string };
type BridgeState = "OFFLINE" | "CONNECTING" | "LIVE";

export function ScannerBridge({
  contextLabel,
  purpose,
  enabled = true,
  placeholder,
  onScan,
  onFeedback,
}: {
  contextLabel: string;
  purpose: "POS" | "INVENTORY";
  enabled?: boolean;
  placeholder: string;
  onScan: (code: string) => void | Promise<void>;
  onFeedback?: (message: string, tone?: "success" | "error") => void;
}) {
  const [code, setCode] = useState("");
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ScannerSession[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [issuedUrl, setIssuedUrl] = useState("");
  const [issuedQr, setIssuedQr] = useState("");
  const [bridgeState, setBridgeState] = useState<BridgeState>("OFFLINE");
  const [lastScanAt, setLastScanAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const onScanRef = useRef(onScan);
  const consumerIdRef = useRef(crypto.randomUUID());
  const selectedIdRef = useRef("");
  onScanRef.current = onScan;

  const feedback = useCallback((message: string, tone: "success" | "error" = "success") => {
    onFeedback?.(message, tone);
  }, [onFeedback]);

  const loadSessions = useCallback(async (preferredId?: string) => {
    try {
      const result = await apiRequest<{ sessions: ScannerSession[] }>(`/api/scanner-sessions?purpose=${purpose}`);
      let nextSessions = result.sessions;
      let selected = selectScannerSession(nextSessions, purpose, preferredId, selectedIdRef.current);
      if (selected && selected.purpose !== purpose) {
        selected = await apiRequest<ScannerSession>("/api/scanner-sessions", {
          method: "PATCH",
          body: JSON.stringify({ id: selected._id, purpose }),
        });
        nextSessions = nextSessions.map((session) => session._id === selected._id ? selected : session);
        feedback(`${selected.label} now sends scans to ${contextLabel}.`);
      }
      setSessions(nextSessions);
      selectedIdRef.current = selected?._id || "";
      setSelectedId(selectedIdRef.current);
    } catch (reason) {
      feedback(reason instanceof Error ? reason.message : "Could not load scanner links.", "error");
    }
  }, [contextLabel, feedback, purpose]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);

  useEffect(() => {
    let cancelled = false;
    if (!issuedUrl) { setIssuedQr(""); return; }
    void import("qrcode").then((QRCode) => QRCode.toDataURL(issuedUrl, { errorCorrectionLevel: "H", margin: 2, width: 280 }))
      .then((dataUrl) => { if (!cancelled) setIssuedQr(dataUrl); })
      .catch(() => { if (!cancelled) setIssuedQr(""); });
    return () => { cancelled = true; };
  }, [issuedUrl]);

  useEffect(() => {
    if (!selectedId || !enabled) { setBridgeState(selectedId ? "CONNECTING" : "OFFLINE"); return; }
    let stopped = false;
    let controller: AbortController | null = null;
    let retryTimer: number | null = null;

    const listen = async () => {
      setBridgeState("CONNECTING");
      while (!stopped) {
        if (document.visibilityState === "hidden") {
          await new Promise<void>((resolve) => { retryTimer = window.setTimeout(resolve, 500); });
          continue;
        }
        controller = new AbortController();
        try {
          const events = await apiRequest<ScanEvent[]>(`/api/mobile-scans?sessionId=${selectedId}&consumerId=${encodeURIComponent(consumerIdRef.current)}&purpose=${purpose}&wait=1`, { signal: controller.signal });
          if (stopped) break;
          setBridgeState("LIVE");
          const processed: string[] = [];
          for (const event of events) {
            await onScanRef.current(event.code);
            processed.push(event._id);
            setLastScanAt(new Date(event.createdAt));
          }
          if (processed.length) await apiRequest("/api/mobile-scans", { method: "PATCH", body: JSON.stringify({ sessionId: selectedId, consumerId: consumerIdRef.current, eventIds: processed }) });
        } catch (reason) {
          if (stopped || (reason instanceof DOMException && reason.name === "AbortError")) break;
          setBridgeState("OFFLINE");
          if (reason instanceof Error && /expired|inactive|closed|longer active/i.test(reason.message)) {
            selectedIdRef.current = "";
            setSelectedId("");
            feedback("This scanner moved to another screen. Reopen Link phone to route it back here.", "error");
            break;
          }
          await new Promise<void>((resolve) => { retryTimer = window.setTimeout(resolve, 1_000); });
        }
      }
    };
    void listen();
    return () => {
      stopped = true;
      controller?.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [enabled, feedback, purpose, selectedId]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = code.trim();
    if (!value) return;
    setCode("");
    setLastScanAt(new Date());
    void onScanRef.current(value);
  }

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const label = String(new FormData(event.currentTarget).get("label") || "Counter phone");
    try {
      const result = await apiRequest<{ session: ScannerSession; url: string }>("/api/scanner-sessions", { method: "POST", body: JSON.stringify({ label, purpose }) });
      setIssuedUrl(result.url);
      await loadSessions(result.session._id);
      feedback("24-hour scanner pass issued and selected automatically.");
    } catch (reason) { feedback(reason instanceof Error ? reason.message : "Could not issue the scanner link.", "error"); }
    finally { setBusy(false); }
  }

  async function revokeSession(session: ScannerSession) {
    try {
      await apiRequest("/api/scanner-sessions", { method: "DELETE", body: JSON.stringify({ id: session._id }) });
      setIssuedUrl("");
      await loadSessions();
      feedback("Scanner link revoked immediately.");
    } catch (reason) { feedback(reason instanceof Error ? reason.message : "Could not revoke the scanner link.", "error"); }
  }

  async function useHere(session: ScannerSession) {
    try {
      const routed = session.purpose === purpose ? session : await apiRequest<ScannerSession>("/api/scanner-sessions", {
        method: "PATCH",
        body: JSON.stringify({ id: session._id, purpose }),
      });
      setSessions((current) => current.map((item) => item._id === routed._id ? routed : item));
      selectedIdRef.current = routed._id;
      setSelectedId(routed._id);
      feedback(`${routed.label} now sends scans to ${contextLabel}.`);
      setOpen(false);
    } catch (reason) {
      feedback(reason instanceof Error ? reason.message : "Could not change the scan destination.", "error");
    }
  }

  const selected = sessions.find((session) => session._id === selectedId);

  return <>
    <form className={`scanner-bridge scanner-bridge-${bridgeState.toLowerCase()}`} onSubmit={submit}>
      <div className="scanner-bridge-mark"><ScanLine /><i /></div>
      <div className="scanner-bridge-route"><span>LIVE WHISK LINE · {contextLabel.toUpperCase()}</span><strong>{selected ? selected.label : "USB / Bluetooth scanner"}</strong></div>
      <label><span>SCAN DESTINATION</span><input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" autoCapitalize="characters" placeholder={enabled ? placeholder : "Loading the scan destination…"} disabled={!enabled} aria-label={`${contextLabel} barcode input`} /></label>
      <button className="scanner-read" disabled={!enabled} aria-label="Read code"><Barcode />Read</button>
      <button type="button" className="scanner-connect" onClick={() => { setOpen(true); void loadSessions(); }}><Smartphone />{selected ? "Scanner linked" : "Link / scan"}</button>
      <small><Radio />{!enabled ? "PREPARING SCAN DESTINATION" : bridgeState === "LIVE" ? "LOW-LATENCY LISTENER LIVE" : bridgeState === "CONNECTING" ? "CONNECTING AUTOMATICALLY" : "LOCAL SCANNER READY"}{lastScanAt ? ` · LAST ${lastScanAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}</small>
    </form>
    <Modal open={open} onClose={() => setOpen(false)} title="Link an online scanner" kicker="LINK OR SCAN QR">
      <div className="scanner-link-panel">
        <div className="scanner-link-intro"><Link2 /><div><strong>Automatic active-screen routing</strong><p>Open the pass on a phone and the current POS or Inventory screen claims the newest active device automatically. Each scan is locked to that destination and the phone cannot read products, customers, prices or reports.</p></div></div>
        <form onSubmit={createSession}><label className="field"><span>Device label</span><input name="label" defaultValue={`${contextLabel} phone`} minLength={2} maxLength={60} required /></label><button className="button button-primary" disabled={busy}><Plus />{busy ? "Issuing…" : "Issue 24-hour pass"}</button></form>
        {issuedUrl ? <div className="issued-scanner-connect">{issuedQr ? <img src={issuedQr} alt="QR code that connects a phone scanner to this POS session" /> : null}<div className="issued-scanner-link"><span>SCAN QR OR COPY ONCE · OPEN ON THE PHONE</span><code>{issuedUrl}</code><div><a className="button button-secondary" href={issuedUrl} target="_blank" rel="noreferrer"><Link2 />Open pass</a><button type="button" className="button button-secondary" onClick={() => navigator.clipboard.writeText(issuedUrl)}><Copy />Copy secure link</button></div></div></div> : null}
        <div className="scanner-session-list">{sessions.length ? sessions.map((session) => <article key={session._id} className={selectedId === session._id ? "listening" : ""}><div><strong>{session.label}</strong><span>{session.connectedAt ? "Phone connected" : "Waiting for phone"} · routes to {session.purpose === "INVENTORY" ? "Inventory" : "POS"} · expires {new Intl.DateTimeFormat("en-SG", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(session.expiresAt))}</span></div><button type="button" className="button button-secondary" onClick={() => void useHere(session)} disabled={selectedId === session._id && session.purpose === purpose}>{selectedId === session._id && session.purpose === purpose ? "Listening" : "Use here"}</button><button type="button" className="icon-button danger" title="Revoke scanner pass" onClick={() => void revokeSession(session)}><Unplug /></button></article>) : <p className="scanner-empty">No active phone passes. Issue one to connect automatically.</p>}</div>
      </div>
    </Modal>
  </>;
}
