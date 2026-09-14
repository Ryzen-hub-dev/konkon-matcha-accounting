"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Barcode, Copy, Link2, Plus, Radio, ScanLine, Smartphone, Unplug } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { apiRequest, Modal } from "@/components/ui";
import { selectScannerSession, type ScannerPurpose } from "@/lib/scanner-routing";

type ScannerSession = { _id: string; label: string; purpose: ScannerPurpose; expiresAt: string; connectedAt?: string; lastUsedAt?: string };
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
  purpose: ScannerPurpose;
  enabled?: boolean;
  placeholder: string;
  onScan: (code: string) => void | Promise<void>;
  onFeedback?: (message: string, tone?: "success" | "error") => void;
}) {
  const { dateTime } = useBusiness();
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
  const scanQueueRef = useRef<Promise<void>>(Promise.resolve());
  const loadVersion = useRef(0);
  onScanRef.current = onScan;

  const feedback = useCallback((message: string, tone: "success" | "error" = "success") => {
    onFeedback?.(message, tone);
  }, [onFeedback]);

  const loadSessions = useCallback(async (preferredId?: string) => {
    const version = ++loadVersion.current;
    try {
      const result = await apiRequest<{ sessions: ScannerSession[] }>(`/api/scanner-sessions?purpose=${purpose}`);
      if (version !== loadVersion.current) return;
      let nextSessions = result.sessions;
      let selected = selectScannerSession(nextSessions, purpose, preferredId, selectedIdRef.current);
      if (selected && selected.purpose !== purpose) {
        selected = await apiRequest<ScannerSession>("/api/scanner-sessions", {
          method: "PATCH",
          body: JSON.stringify({ id: selected._id, purpose }),
        });
        if (version !== loadVersion.current) return;
        nextSessions = nextSessions.map((session) => session._id === selected._id ? selected : session);
        feedback(`${selected.label} now sends scans to ${contextLabel}.`);
      }
      setSessions(nextSessions);
      selectedIdRef.current = selected?._id || "";
      setSelectedId(selectedIdRef.current);
    } catch (reason) {
      if (version !== loadVersion.current) return;
      feedback(reason instanceof Error ? reason.message : "Could not load scanner links.", "error");
    }
  }, [contextLabel, feedback, purpose]);

  useEffect(() => {
    const reconnect = () => { void loadSessions(); };
    window.addEventListener("konkon:nfc-binding-released", reconnect);
    reconnect();
    return () => { loadVersion.current++; window.removeEventListener("konkon:nfc-binding-released", reconnect); };
  }, [loadSessions]);

  useEffect(() => {
    let cancelled = false;
    if (!issuedUrl) { setIssuedQr(""); return; }
    void import("qrcode").then((QRCode) => QRCode.toDataURL(issuedUrl, { errorCorrectionLevel: "H", margin: 2, width: 280 }))
      .then((dataUrl) => { if (!cancelled) setIssuedQr(dataUrl); })
      .catch(() => { if (!cancelled) setIssuedQr(""); });
    return () => { cancelled = true; };
  }, [issuedUrl]);

  const listeningSessions = sessions.filter((session) => session.purpose === purpose);
  const listeningKey = listeningSessions.map((session) => session._id).sort().join(",");

  useEffect(() => {
    const listeningIds = listeningKey ? listeningKey.split(",") : [];
    if (!listeningIds.length || !enabled) { setBridgeState(listeningIds.length ? "CONNECTING" : "OFFLINE"); return; }
    let stopped = false;
    const controllers = new Map<string, AbortController>();
    const liveIds = new Set<string>();
    const updateState = () => { if (!stopped) setBridgeState(liveIds.size ? "LIVE" : "CONNECTING"); };

    const listen = async (sessionId: string) => {
      updateState();
      while (!stopped) {
        if (document.visibilityState === "hidden") {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
          continue;
        }
        const controller = new AbortController();
        controllers.set(sessionId, controller);
        try {
          const events = await apiRequest<ScanEvent[]>(`/api/mobile-scans?sessionId=${sessionId}&consumerId=${encodeURIComponent(consumerIdRef.current)}&purpose=${purpose}&wait=1`, { signal: controller.signal });
          if (stopped) break;
          liveIds.add(sessionId); updateState();
          const processed: string[] = [];
          for (const event of events) {
            const task = scanQueueRef.current.then(() => onScanRef.current(event.code));
            scanQueueRef.current = task.catch(() => {});
            await task;
            processed.push(event._id);
            setLastScanAt(new Date(event.createdAt));
          }
          if (processed.length) await apiRequest("/api/mobile-scans", { method: "PATCH", body: JSON.stringify({ sessionId, consumerId: consumerIdRef.current, eventIds: processed }) });
        } catch (reason) {
          if (stopped || (reason instanceof DOMException && reason.name === "AbortError")) break;
          liveIds.delete(sessionId); updateState();
          if (reason instanceof Error && /expired|inactive|closed|longer active/i.test(reason.message)) {
            setSessions((current) => {
              const remaining = current.filter((session) => session._id !== sessionId);
              if (selectedIdRef.current === sessionId) {
                selectedIdRef.current = remaining.find((session) => session.purpose === purpose)?._id || "";
                setSelectedId(selectedIdRef.current);
              }
              return remaining;
            });
            feedback("One phone moved to another screen. Other linked phones keep listening here.", "error");
            break;
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 1_000));
        } finally {
          controllers.delete(sessionId);
        }
      }
    };
    for (const sessionId of listeningIds) void listen(sessionId);
    return () => {
      stopped = true;
      for (const controller of controllers.values()) controller.abort();
    };
  }, [enabled, feedback, listeningKey, purpose]);

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
  const linkedLabel = listeningSessions.length > 1 ? `${listeningSessions.length} phones listening` : selected?.label;

  return <>
    <form className={`scanner-bridge scanner-bridge-${bridgeState.toLowerCase()}`} onSubmit={submit}>
      <div className="scanner-bridge-mark"><ScanLine /><i /></div>
      <div className="scanner-bridge-route"><span>LIVE WHISK LINE · {contextLabel.toUpperCase()}</span><strong>{linkedLabel || "USB / Bluetooth scanner"}</strong></div>
      <label><span>SCAN DESTINATION</span><input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" autoCapitalize="characters" placeholder={enabled ? placeholder : "Loading the scan destination…"} disabled={!enabled} aria-label={`${contextLabel} barcode input`} /></label>
      <button className="scanner-read" disabled={!enabled} aria-label="Read code"><Barcode />Read</button>
      <button type="button" className="scanner-connect" onClick={() => { setOpen(true); void loadSessions(); }}><Smartphone />{listeningSessions.length > 1 ? `${listeningSessions.length} phones linked` : selected ? "Scanner linked" : "Link / scan"}</button>
      <small><Radio />{!enabled ? "PREPARING SCAN DESTINATION" : bridgeState === "LIVE" ? listeningSessions.length > 1 ? `${listeningSessions.length} PHONE LISTENERS LIVE` : "LOW-LATENCY LISTENER LIVE" : bridgeState === "CONNECTING" ? "CONNECTING AUTOMATICALLY" : "LOCAL SCANNER READY"}{lastScanAt ? ` · LAST ${lastScanAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}</small>
    </form>
    <Modal open={open} onClose={() => setOpen(false)} title="Link an online scanner" kicker="LINK OR SCAN QR">
      <div className="scanner-link-panel">
        <div className="scanner-link-intro"><Link2 /><div><strong>Independent phones, one destination</strong><p>Every phone routed here listens at the same time. Keep one phone on barcode/camera scanning and another on Tap-to-read NFC; scans are queued safely in arrival order. Each phone can only send codes and cannot read products, customers, prices or reports.</p></div></div>
        <form onSubmit={createSession}><label className="field"><span>Device label</span><input name="label" defaultValue={`${contextLabel} phone`} minLength={2} maxLength={60} required /></label><button className="button button-primary" disabled={busy}><Plus />{busy ? "Issuing…" : "Issue 24-hour pass"}</button></form>
        {issuedUrl ? <div className="issued-scanner-connect">{issuedQr ? <img src={issuedQr} alt="QR code that connects a phone scanner to this POS session" /> : null}<div className="issued-scanner-link"><span>SCAN QR OR COPY ONCE · OPEN ON THE PHONE</span><code>{issuedUrl}</code><div><a className="button button-secondary" href={issuedUrl} target="_blank" rel="noreferrer"><Link2 />Open pass</a><button type="button" className="button button-secondary" onClick={() => navigator.clipboard.writeText(issuedUrl)}><Copy />Copy secure link</button></div></div></div> : null}
        <div className="scanner-session-list">{sessions.length ? sessions.map((session) => <article key={session._id} className={session.purpose === purpose ? "listening" : ""}><div><strong>{session.label}</strong><span>{session.connectedAt ? "Phone connected" : "Waiting for phone"} · routes to {session.purpose} · expires {dateTime.format(new Date(session.expiresAt))}</span></div><button type="button" className="button button-secondary" onClick={() => void useHere(session)} disabled={session.purpose === purpose}>{session.purpose === purpose ? "Listening" : "Use here"}</button><button type="button" className="icon-button danger" title="Revoke scanner pass" onClick={() => void revokeSession(session)}><Unplug /></button></article>) : <p className="scanner-empty">No active phone passes. Issue one to connect automatically.</p>}</div>
      </div>
    </Modal>
  </>;
}
