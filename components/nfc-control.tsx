"use client";
import { useEffect, useRef, useState } from "react";
import { Nfc } from "lucide-react";
import { memberScanToken } from "@/lib/scan-codes";

type NdefRecord = { recordType: string; data?: DataView; encoding?: string };
type Ndef = { scan(options: { signal: AbortSignal }): Promise<void>; write(message: { records: Array<{ recordType: string; data: string }> }, options: { signal: AbortSignal }): Promise<void>; onreading: ((event: { message: { records: NdefRecord[] } }) => void) | null; onreadingerror: (() => void) | null };
type NdefConstructor = new () => Ndef;

export function NfcControl({ onRead, writeToken, disabled = false }: { onRead?: (code: string) => void | Promise<void>; writeToken?: string; disabled?: boolean }) {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const readRef = useRef(onRead); readRef.current = onRead;
  useEffect(() => {
    setSupported(window.isSecureContext && "NDEFReader" in window);
    const pause = () => { if (document.visibilityState === "hidden") { controller.current?.abort(); setBusy(false); } };
    document.addEventListener("visibilitychange", pause);
    return () => { controller.current?.abort(); document.removeEventListener("visibilitychange", pause); };
  }, []);
  async function begin() {
    if (busy) { controller.current?.abort(); setBusy(false); setMessage("NFC stopped."); return; }
    const Reader = (window as unknown as { NDEFReader?: NdefConstructor }).NDEFReader;
    if (!Reader) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy(true); setMessage(writeToken ? "Hold the NFC card against the phone to write it." : "Hold the member card against the phone.");
    try {
      const reader = new Reader();
      if (writeToken) {
        const code = memberScanToken(writeToken); if (!code) throw new Error("The member card code is invalid.");
        await reader.write({ records: [{ recordType: "text", data: code }] }, { signal: abort.signal });
        setMessage("Member card written. Test it at the counter before handing it over."); setBusy(false);
      } else {
        let lastCode = ""; let lastAt = 0;
        reader.onreading = event => {
          for (const record of event.message.records) {
            if (!["text", "url"].includes(record.recordType) || !record.data || record.data.byteLength > 2048) continue;
            try {
              const token = memberScanToken(new TextDecoder(record.encoding || "utf-8").decode(record.data));
              if (!token) continue;
              if (lastCode === token && Date.now() - lastAt < 2000) return;
              lastCode = token; lastAt = Date.now();
              setMessage("Member card read. Checking at the counter…");
              void Promise.resolve(readRef.current?.(token)).catch(() => setMessage("The card could not be sent. Try again.")); return;
            } catch { /* other NDEF records are not membership credentials */ }
          }
          setMessage("No Kōn-Kōn member credential found. Use a card issued by this store.");
        };
        reader.onreadingerror = () => setMessage("Card could not be read. Hold it steady and try again.");
        await reader.scan({ signal: abort.signal });
      }
    } catch (error) {
      if (!abort.signal.aborted) setMessage(error instanceof Error && error.name === "NotAllowedError" ? "Allow NFC access in this browser, then try again." : "NFC unavailable. Check NFC is enabled and the card supports NDEF.");
      setBusy(false);
    }
  }
  return <section className="nfc-control no-print"><button type="button" className="button button-secondary" disabled={!supported || disabled} onClick={() => void begin()}><Nfc size={18} />{busy ? "Stop NFC" : writeToken ? "Write member card" : "Start NFC reader"}</button><p aria-live="polite">{message || (supported ? writeToken ? "Writing replaces this tag’s NFC records. Use a dedicated member card." : "Tap an issued NDEF member card to identify its holder." : "Web NFC requires a compatible Android phone, Chrome, HTTPS and an NDEF card. Use QR on other devices.")}</p></section>;
}
