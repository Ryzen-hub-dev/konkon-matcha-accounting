"use client";
import { useEffect, useRef, useState } from "react";
import { Smartphone, CheckCircle2 } from "lucide-react";
import { apiRequest } from "./ui";
import { QrImage } from "./qr-image";
import { NfcControl } from "./nfc-control";
import { memberBindingScanToken } from "@/lib/scan-codes";

type Pass = { _id: string; label: string; expiresAt: string; connectedAt?: string; bindingLeaseId?: string };
export function RemoteNfcBinding({ memberId, memberName, onBound }: { memberId: string; memberName: string; onBound: () => Promise<void> }) {
  const [pass, setPass] = useState<Pass | null>(null);
  const [devices, setDevices] = useState<Pass[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const consumer = useRef(crypto.randomUUID());
  const pendingRef = useRef("");
  const pendingRemote = useRef(false);
  const busyRef = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const leaseId = useRef(crypto.randomUUID());
  const releasedLease = useRef("");

  async function loadDevices() {
    const result = await apiRequest<{ sessions: Pass[] }>("/api/scanner-sessions?purpose=MEMBERS");
    setDevices(result.sessions); setDeviceId(result.sessions[0]?._id || "");
  }
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      apiRequest<{ sessions: Pass[] }>(`/api/scanner-sessions?purpose=MEMBER_BIND&memberId=${memberId}`),
      apiRequest<{ sessions: Pass[] }>("/api/scanner-sessions?purpose=MEMBERS"),
    ]).then(([locked, available]) => {
      if (cancelled) return;
      setDevices(available.sessions); setDeviceId(available.sessions[0]?._id || "");
      if (locked.sessions[0]) { setPass(locked.sessions[0]); setStatus("Connected reader restored. Keep its Tap-to-read NFC page open."); }
    }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load the reader. Reload this page to retry."); })
      .finally(() => { if (!cancelled) setRestoring(false); });
    return () => { cancelled = true; };
  }, [memberId]);

  const releaseBody = (current: Pass) => JSON.stringify({ id: current._id, purpose: "MEMBERS", bindingMemberId: memberId, bindingLeaseId: current.bindingLeaseId });
  useEffect(() => {
    if (!pass?.bindingLeaseId) return;
    const body = JSON.stringify({ id: pass._id, purpose: "MEMBERS", bindingMemberId: memberId, bindingLeaseId: pass.bindingLeaseId });
    // Release only this member's reservation, never the shared phone pass.
    // The lease prevents an old tab from releasing a newer binding.
    const releaseOnLeave = () => {
      if (releasedLease.current === pass.bindingLeaseId) return;
      releasedLease.current = pass.bindingLeaseId!;
      void fetch("/api/scanner-sessions", { method: "PATCH", headers: { "Content-Type": "application/json" }, body, keepalive: true })
        .then(response => { if (response.ok) window.dispatchEvent(new Event("konkon:nfc-binding-released")); })
        .catch(() => {});
    };
    window.addEventListener("pagehide", releaseOnLeave);
    return () => { window.removeEventListener("pagehide", releaseOnLeave); releaseOnLeave(); };
  }, [pass, memberId]);

  function receive(code: string, remote = false) {
    if (pendingRef.current || busyRef.current) return;
    if (!memberBindingScanToken(code)) throw new Error("Tap an existing NFC card to bind it.");
    pendingRef.current = code; pendingRemote.current = remote; requestId.current = crypto.randomUUID();
    setPending(code); setError(""); setStatus("Card received. Check the member and confirm below.");
  }
  useEffect(() => {
    if (!pass) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function listen() {
      try {
        if (document.visibilityState !== "hidden" && !pendingRef.current && !busyRef.current) {
          const lease = pass!.bindingLeaseId ? `&bindingLeaseId=${pass!.bindingLeaseId}` : "";
          const events = await apiRequest<Array<{ _id: string; code: string }>>(`/api/mobile-scans?sessionId=${pass!._id}&consumerId=${consumer.current}&purpose=MEMBER_BIND&memberId=${memberId}${lease}&wait=1`, { signal: controller.signal });
          if (cancelled) return;
          if (events.length) {
            await apiRequest("/api/mobile-scans", { method: "PATCH", body: JSON.stringify({ sessionId: pass!._id, consumerId: consumer.current, eventIds: events.map(event => event._id) }), signal: controller.signal });
            if (cancelled) return;
            receive(events[0].code, true);
          }
        }
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "Reader disconnected.");
        if (reason instanceof Error && /expired|longer active|another member|binding has changed|not accepting/i.test(reason.message)) { setPass(null); setPending(""); pendingRef.current = ""; return; }
      }
      if (!cancelled) timer = setTimeout(() => void listen(), pendingRef.current || document.visibilityState === "hidden" ? 1000 : 250);
    }
    void listen();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [pass, memberId]);

  async function connect(newPhone = false) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      if (deviceId && !newPhone) {
        const selected = await apiRequest<Pass>("/api/scanner-sessions", { method: "PATCH", body: JSON.stringify({ id: deviceId, purpose: "MEMBER_BIND", bindingMemberId: memberId, bindingLeaseId: leaseId.current }) });
        setPass(selected); setUrl(""); setStatus("Using the same Tap-to-read NFC phone. Tap a card; no new QR or NFC restart is needed.");
      } else {
        const result = await apiRequest<{ session: Pass; url: string }>("/api/scanner-sessions", { method: "POST", body: JSON.stringify({ label: "Tap-to-read NFC phone", purpose: "MEMBER_BIND", bindingMemberId: memberId, sharedReader: true }) });
        setPass(result.session); setUrl(result.url); setStatus("Open this pass on the phone and allow NFC once.");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not connect the NFC phone."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function release() {
    if (!pass) return;
    if (pass.bindingLeaseId) {
      await apiRequest("/api/scanner-sessions", { method: "PATCH", body: releaseBody(pass) });
      releasedLease.current = pass.bindingLeaseId;
      window.dispatchEvent(new Event("konkon:nfc-binding-released"));
    }
    else await apiRequest("/api/scanner-sessions", { method: "DELETE", body: JSON.stringify({ id: pass._id }) });
    setPass(null); setUrl(""); pendingRef.current = ""; setPending(""); leaseId.current = crypto.randomUUID();
    await loadDevices();
  }
  async function finish() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await release(); setStatus("Binding finished. The shared NFC phone is ready for Members and POS."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not finish binding. Try again."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function bind() {
    if (!pending || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      await apiRequest("/api/member-cards", { method: "POST", body: JSON.stringify({ action: "BIND", memberId, code: pending, ...(pendingRemote.current && pass ? { readerSessionId: pass._id, readerBindingLeaseId: pass.bindingLeaseId } : {}), clientRequestId: requestId.current }) });
      pendingRef.current = ""; setPending("");
      await onBound();
      if (pass) await release();
      setStatus(`NFC card bound to ${memberName}. The card was not changed. The reader stays ready.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not bind this card."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  return <section className="remote-nfc-binding unified-nfc-binding no-print" aria-label="Member Tap-to-read NFC">
    <header><span className="eyebrow">ONE NFC READER · MEMBERS & POS</span><h3>Tap-to-read NFC</h3><p>Bind an existing card to <strong>{memberName}</strong>. Use the same phone as POS, or read on this device. Confirm each new binding below.</p></header>
    <div className="nfc-binding-devices">
      <section><h4><Smartphone size={18} /> Connected phone</h4>
        {!pass ? <><p>{devices.length ? "Reuse a linked Tap-to-read NFC phone. Keep its page open." : "Connect a compatible NFC phone once, then keep using it in Members and POS."}</p>{devices.length ? <label className="field"><span>NFC phone</span><select value={deviceId} onChange={event => { setDeviceId(event.target.value); leaseId.current = crypto.randomUUID(); }}>{devices.map(device => <option key={device._id} value={device._id}>{device.label}</option>)}</select></label> : null}<div className="nfc-binding-actions"><button type="button" className="button button-primary" disabled={busy || restoring} onClick={() => void connect()}>{restoring ? "Finding NFC phones…" : busy ? "Connecting…" : devices.length ? "Use connected NFC phone" : "Connect NFC phone"}</button>{devices.length ? <button type="button" className="button button-secondary" disabled={busy || restoring} onClick={() => void connect(true)}>Link a new phone</button> : null}</div></> : <><p className="nfc-connected-state"><CheckCircle2 size={18} />{pass.label} · ready for this member</p><p>Keep the phone’s Tap-to-read NFC page open. It returns to member lookup after confirmation.</p><button type="button" className="button button-secondary" disabled={busy} onClick={() => void finish()}>Finish binding</button></>}
      </section>
      <section><h4>This device</h4><NfcControl autoStart alwaysOn onGenericRead={code => receive(code)} /><small>Only readable NFC cards can be recorded. Existing card contents are not changed.</small></section>
    </div>
    {pass && url ? <div className="reader-pairing"><QrImage value={url} label="Open Tap-to-read NFC on the phone" width={180} /><div><strong>Open once, keep reading</strong><p>Allow NFC once if prompted. Keep the phone unlocked and this page visible. Private pass expires {new Date(pass.expiresAt).toLocaleString()}.</p><a className="button button-secondary" href={url} target="_blank" rel="noreferrer">Open reader pass</a></div></div> : null}
    {pending ? <div className="reader-confirm"><span className="eyebrow">CARD RECEIVED · •••• {pending.slice(-4).toUpperCase()}</span><p>Bind this card to <strong>{memberName}</strong>?</p><button type="button" className="button button-primary" disabled={busy} onClick={() => void bind()}>{busy ? "Binding…" : "Confirm NFC binding"}</button><button type="button" className="button button-secondary" disabled={busy} onClick={() => { pendingRef.current = ""; setPending(""); setError(""); setStatus("Ready. Tap the next card on the same reader."); }}>Discard and read again</button></div> : null}
    <p role="status">{status}</p>{error ? <p className="card-error" role="alert">{error}</p> : null}
  </section>;
}
