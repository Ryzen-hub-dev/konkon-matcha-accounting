"use client";
import { useEffect, useRef, useState } from "react";
import { Nfc } from "lucide-react";
import { memberBindingScanToken, memberScanToken } from "@/lib/scan-codes";

type NdefRecord = { recordType: string; data?: DataView; encoding?: string; mediaType?: string };
type Ndef = { scan(options: { signal: AbortSignal }): Promise<void>; write(message: { records: Array<{ recordType: string; data: string }> }, options: { signal: AbortSignal }): Promise<void>; onreading: ((event: { message: { records: NdefRecord[] } }) => void) | null; onreadingerror: (() => void) | null };
type NdefConstructor = new () => Ndef;

function bytes(record: NdefRecord) {
  if (!record.data || record.data.byteLength > 2048) return "";
  return btoa(String.fromCodePoint(...new Uint8Array(record.data.buffer, record.data.byteOffset, record.data.byteLength))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function bindingCode(event: { serialNumber?: string; message: { records: NdefRecord[] } }) {
  const serial = String(event.serialNumber || "").trim().toUpperCase();
  const records = serial ? [] : event.message.records.map(record => ({ recordType: record.recordType, mediaType: record.mediaType || "", encoding: record.encoding || "", data: bytes(record) })).filter(record => record.data || record.recordType);
  if (!serial && !records.some(record => record.data)) return "";
  const material = serial ? `serial:${serial}` : `ndef:${JSON.stringify(records)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  return `KKNT1-${serial ? "S" : "N"}-${fingerprint}`;
}

export function NfcControl({ onRead, onGenericRead, stopAfterGeneric = false, writeToken, disabled = false, autoStart = false, alwaysOn = false }: { onRead?: (code: string) => void | Promise<void>; onGenericRead?: (code: string) => void | Promise<void>; stopAfterGeneric?: boolean; writeToken?: string; disabled?: boolean; autoStart?: boolean; alwaysOn?: boolean }) {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pageHidden, setPageHidden] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const listeningRef = useRef(false);
  const readRef = useRef(onRead); readRef.current = onRead;
  const genericRef = useRef(onGenericRead); genericRef.current = onGenericRead;
  const beginRef = useRef<() => void>(() => {});
  const autoStartAttempted = useRef(false);
  const setListening = (value: boolean) => { listeningRef.current = value; setBusy(value); };
  useEffect(() => {
    setListening(false);
    autoStartAttempted.current = false;
    return () => {
      controller.current?.abort();
      controller.current = null;
      listeningRef.current = false;
    };
  }, [disabled, writeToken]);
  useEffect(() => {
    setSupported(window.isSecureContext && "NDEFReader" in window);
    // Web NFC suspends in the background and resumes the same subscription
    // automatically. Aborting here would unnecessarily require a fresh scan.
    const visibility = () => setPageHidden(document.visibilityState === "hidden");
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (!alwaysOn || !busy || disabled || writeToken || !("wakeLock" in navigator)) return;
    let cancelled = false;
    let pending = false;
    let lock: WakeLockSentinel | undefined;
    const keepAwake = async () => {
      if (cancelled || pending || (lock && !lock.released) || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (cancelled) await next.release();
        else lock = next;
      } catch { /* Power saving and browser policy may deny a wake lock. */ }
      finally { pending = false; }
    };
    void keepAwake();
    document.addEventListener("visibilitychange", keepAwake);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", keepAwake); void lock?.release().catch(() => {}); };
  }, [alwaysOn, busy, disabled, writeToken]);
  async function begin() {
    if (disabled || document.visibilityState === "hidden") return;
    if (listeningRef.current) {
      if (alwaysOn) return;
      controller.current?.abort(); setListening(false); setMessage("NFC stopped."); return;
    }
    const Reader = (window as unknown as { NDEFReader?: NdefConstructor }).NDEFReader;
    if (!Reader) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setListening(true); setMessage(writeToken ? "Hold the NFC card against the phone to write it." : "Hold the member card against the phone.");
    try {
      const reader = new Reader();
      if (writeToken) {
        const code = memberScanToken(writeToken); if (!code) throw new Error("The member card code is invalid.");
        await reader.write({ records: [{ recordType: "text", data: code }] }, { signal: abort.signal });
        if (abort.signal.aborted) return;
        setMessage("Member card written. Test it at the counter before handing it over."); setListening(false);
      } else {
        let lastCode = ""; let lastAt = 0; let processing = false;
        reader.onreading = async event => {
          if (abort.signal.aborted || processing || document.visibilityState === "hidden") return;
          const genericEvent = event as typeof event & { serialNumber?: string };
          const rawRecords = event.message.records;
          for (const record of event.message.records) {
            if (!["text", "url"].includes(record.recordType) || !record.data || record.data.byteLength > 2048) continue;
            try {
              const token = memberScanToken(new TextDecoder(record.encoding || "utf-8").decode(record.data));
              if (!token) continue;
              if (!readRef.current) { setMessage("This is an issued member credential. Use it for lookup; it cannot be rebound as an existing card."); return; }
              if (lastCode === token && Date.now() - lastAt < 2000) return;
              processing = true;
              setMessage("Member card read. Checking at the counter…");
              try {
                await readRef.current(token);
                if (abort.signal.aborted) return;
                lastCode = token; lastAt = Date.now();
                setMessage("Member card sent. Ready for the next card.");
              } catch { if (!abort.signal.aborted) setMessage("The card could not be sent. Tap it again to retry."); }
              finally { processing = false; }
              return;
            } catch { /* other NDEF records are not membership credentials */ }
          }
          if (genericRef.current) {
            processing = true;
            try {
            const code = await bindingCode({ serialNumber: genericEvent.serialNumber, message: { records: rawRecords } });
            if (abort.signal.aborted) return;
            if (!code || !memberBindingScanToken(code)) { setMessage("This card did not expose a readable NFC identity. Use QR or a supported NDEF reader."); return; }
            if (lastCode === code && Date.now() - lastAt < 2000) return;
            setMessage("NFC fingerprint read. Sending securely…");
            await genericRef.current(code);
            if (abort.signal.aborted) return;
            lastCode = code; lastAt = Date.now();
            setMessage(stopAfterGeneric ? "Card sent. Check the counter for confirmation." : "Card sent. Ready for the next card.");
            if (stopAfterGeneric) { abort.abort(); setListening(false); }
            } catch { if (!abort.signal.aborted) setMessage("The card could not be sent. Tap it again to retry."); } finally { processing = false; }
            return;
          }
          setMessage("No Kōn-Kōn member credential found. Use a card issued by this store.");
        };
        reader.onreadingerror = () => { if (!abort.signal.aborted) setMessage("Card could not be read. Hold it steady and try again."); };
        await reader.scan({ signal: abort.signal });
      }
    } catch (error) {
      if (abort.signal.aborted || controller.current !== abort) return;
      setMessage(error instanceof Error && error.name === "NotAllowedError" ? "Tap Start NFC once to allow this phone to read cards." : "NFC unavailable. Check NFC is enabled and the card supports NDEF.");
      setListening(false);
    }
  }
  beginRef.current = () => { void begin(); };
  useEffect(() => {
    if (!autoStart || !supported || disabled || writeToken || busy || pageHidden || autoStartAttempted.current) return;
    const timer = window.setTimeout(() => { autoStartAttempted.current = true; beginRef.current(); }, 0);
    return () => window.clearTimeout(timer);
  }, [autoStart, busy, disabled, pageHidden, supported, writeToken]);
  const defaultMessage = supported
    ? writeToken ? "Writing replaces this tag’s NFC records. Use a dedicated member card."
      : autoStart ? "Keep this page visible and the phone unlocked. Allow NFC once, then tap cards without pressing a button each time."
        : onGenericRead ? "Tap an issued or readable NFC card. Other cards are fingerprinted without writing to them."
          : "Tap an issued NDEF member card to identify its holder."
    : "Web NFC requires a compatible Android phone, Chrome, HTTPS and an NDEF card. Use QR on other devices.";
  return <section className={`nfc-control no-print ${busy && !pageHidden ? "nfc-listening" : ""}`} data-nfc-auto-start={autoStart ? "true" : "false"} data-nfc-always-on={alwaysOn ? "true" : "false"}>
    <div className="nfc-control-heading"><span className="nfc-signal" aria-hidden="true"><Nfc size={18} /></span><div><strong>{writeToken ? "Write NFC member card" : "NFC reader"}</strong><small>{busy ? pageHidden ? "RESUMES WHEN THIS PAGE IS VISIBLE" : "LISTENING LIVE · HOLD A CARD NEAR THE PHONE" : autoStart ? "AUTO-READY · SEPARATE FROM BARCODE SCANNER" : "SEPARATE CARD READER"}</small></div></div>
    {busy && alwaysOn ? <span className="nfc-status-pill" role="status" aria-label="NFC reader listening"><Nfc size={18} />{pageHidden ? "Resumes on return" : "NFC listening"}</span> : supported ? <button type="button" className="button button-secondary" disabled={disabled} onClick={() => void begin()} aria-label={busy ? "Stop NFC reader" : writeToken ? "Write member card" : "Start NFC reader"}><Nfc size={18} />{busy ? "Stop NFC reader" : writeToken ? "Write member card" : "Start NFC reader"}</button> : <span className="nfc-device-unavailable">Use a compatible NFC phone</span>}
    <p aria-live="polite">{message || defaultMessage}</p>
  </section>;
}
