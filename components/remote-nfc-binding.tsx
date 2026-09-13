"use client";
import { useEffect, useRef, useState } from "react";
import { Smartphone, Unplug } from "lucide-react";
import { apiRequest } from "./ui";
import { QrImage } from "./qr-image";
import { memberBindingScanToken } from "@/lib/scan-codes";

type Pass = { _id: string; expiresAt: string };
export function RemoteNfcBinding({ memberId, memberName, onBound }: { memberId: string; memberName: string; onBound: () => Promise<void> }) {
  const [pass, setPass] = useState<Pass | null>(null);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const consumer = useRef(crypto.randomUUID());
  const pendingRef = useRef("");
  const requestId = useRef(crypto.randomUUID());
  const [restoring, setRestoring] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void apiRequest<{ sessions: Pass[] }>(`/api/scanner-sessions?purpose=MEMBER_BIND&memberId=${memberId}`).then(result => {
      if (!cancelled && result.sessions[0]) { setPass(result.sessions[0]); setStatus("Resumed this member’s existing NFC reader. Reopen its link on the phone, or disconnect to issue a new QR."); }
    }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not restore the reader."); }).finally(() => { if (!cancelled) setRestoring(false); });
    return () => { cancelled = true; };
  }, [memberId]);
  useEffect(() => {
    if (!pass) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function listen() {
      try {
        if (document.visibilityState !== "hidden" && !pendingRef.current) {
          const events = await apiRequest<Array<{ _id: string; code: string }>>(`/api/mobile-scans?sessionId=${pass!._id}&consumerId=${consumer.current}&purpose=MEMBER_BIND&memberId=${memberId}&wait=1`, { signal: controller.signal });
          if (cancelled) return;
          if (events.length) {
            const code = events.find(event => memberBindingScanToken(event.code))?.code || "";
            pendingRef.current = code; setPending(code); requestId.current = crypto.randomUUID();
            await apiRequest("/api/mobile-scans", { method: "PATCH", body: JSON.stringify({ sessionId: pass!._id, consumerId: consumer.current, eventIds: events.map(event => event._id) }), signal: controller.signal });
            setStatus("Card received. Confirm the member below before binding.");
          } else setStatus("Reader ready. Open the pass on your phone and start NFC.");
        }
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "Reader disconnected.");
        if (reason instanceof Error && /expired|longer active|another member|not accepting/i.test(reason.message)) { setPass(null); setPending(""); pendingRef.current = ""; return; }
      }
      if (!cancelled) timer = setTimeout(() => void listen(), pendingRef.current || document.visibilityState === "hidden" ? 1000 : 250);
    }
    void listen();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [pass, memberId]);
  async function connect() {
    setBusy(true); setError("");
    try {
      const result = await apiRequest<{ session: Pass; url: string }>("/api/scanner-sessions", { method: "POST", body: JSON.stringify({ label: "Member NFC reader", purpose: "MEMBER_BIND", bindingMemberId: memberId }) });
      setPass(result.session); setUrl(result.url); setStatus("Scan this QR with the other phone’s camera.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not connect a phone."); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (!pass) return;
    setBusy(true); setError("");
    try { await apiRequest("/api/scanner-sessions", { method: "DELETE", body: JSON.stringify({ id: pass._id }) }); setPass(null); setUrl(""); setPending(""); pendingRef.current = ""; setStatus("Phone disconnected. The link no longer works."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not disconnect."); }
    finally { setBusy(false); }
  }
  async function bind() {
    if (!pass || !pending || busy) return;
    setBusy(true); setError("");
    try {
      await apiRequest("/api/member-cards", { method: "POST", body: JSON.stringify({ action: "BIND", memberId, code: pending, readerSessionId: pass._id, clientRequestId: requestId.current }) });
      setPending(""); pendingRef.current = ""; setStatus(`NFC card bound to ${memberName}. The card was not changed.`); await onBound();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not bind this card."); }
    finally { setBusy(false); }
  }
  return <section className="remote-nfc-binding">
    <h3><Smartphone size={20} /> Use another phone as the NFC reader</h3>
    <p>Open a private 24-hour pass on a compatible Android phone. This reader is locked to <strong>{memberName}</strong>; other scanner screens cannot take it over.</p>
    {!pass ? <button type="button" className="button button-primary" disabled={busy || restoring} onClick={() => void connect()}>Connect another phone</button> : <>
      <div className="reader-pairing">{url ? <QrImage value={url} label="Connect another phone as this member’s NFC reader" width={180} /> : <strong>Existing reader resumed</strong>}<div><strong>Scan → Start NFC → Tap card</strong><p>Keep both screens open. No login or member details are sent to the phone. Do not share this pass. Expires {new Date(pass.expiresAt).toLocaleString()}.</p>{url ? <a className="button button-secondary" href={url} target="_blank" rel="noreferrer">Open reader pass</a> : <p>The private link is shown only when issued. Use the phone already connected, or disconnect and create a new link.</p>}<button type="button" className="button button-secondary" disabled={busy} onClick={() => void disconnect()}><Unplug size={16} />Disconnect</button></div></div>
      {pending ? <div className="reader-confirm"><span className="eyebrow">CARD RECEIVED · •••• {pending.slice(-4).toUpperCase()}</span><p>Bind this card to <strong>{memberName}</strong>?</p><button type="button" className="button button-primary" disabled={busy} onClick={() => void bind()}>{busy ? "Binding…" : "Confirm NFC binding"}</button><button type="button" className="button button-secondary" disabled={busy} onClick={() => { pendingRef.current = ""; setPending(""); setError(""); }}>Discard and read again</button></div> : null}
    </>}
    <p role="status">{status}</p>{error ? <p className="card-error" role="alert">{error}</p> : null}
  </section>;
}
