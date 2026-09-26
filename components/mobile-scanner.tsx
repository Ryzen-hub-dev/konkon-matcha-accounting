"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, CheckCircle2, Flashlight, Keyboard, Radio, ScanBarcode, Sprout } from "lucide-react";
import type { IScannerControls } from "@zxing/browser";
import { apiRequest } from "@/components/ui";
import { NfcControl } from "./nfc-control";
import type { ScannerPurpose } from "@/lib/scanner-routing";
import type { PublicBranding } from "@/lib/business-settings";

type Detector = { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> };
type DetectorConstructor = {
  new (options?: { formats?: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
};

const REQUESTED_FORMATS = ["code_128", "code_39", "codabar", "data_matrix", "ean_13", "ean_8", "itf", "pdf417", "qr_code", "upc_a", "upc_e"];

export function MobileScanner({ token, branding }: { token: string; branding: PublicBranding }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const cameraActiveRef = useRef(false);
  const busyRef = useRef(false);
  const lastRef = useRef({ code: "", at: 0 });
  const [cameraActive, setCameraActive] = useState(false);
  const [paired, setPaired] = useState(false);
  const [nfcBinding, setNfcBinding] = useState(false);
  const [decoder, setDecoder] = useState("Multi-format decoder ready");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [status, setStatus] = useState("Connecting to the counter automatically…");
  const [tone, setTone] = useState<"idle" | "good" | "bad">("idle");

  const send = useCallback(async (rawCode: string) => {
    const code = rawCode.trim();
    if (!code) return;
    // Camera/NFC readers can emit the same value several times while a card or
    // barcode is held in place. Ignore an in-flight duplicate quietly so it
    // cannot flash a false error or queue a second request.
    if (busyRef.current) return;
    const now = Date.now();
    if (lastRef.current.code === code && now - lastRef.current.at < 1_500) return;
    busyRef.current = true;
    try {
      const result = await apiRequest<{ purpose: ScannerPurpose }>("/api/mobile-scans", { method: "POST", body: JSON.stringify({ token, code }) });
      setNfcBinding(result.purpose === "MEMBER_BIND");
      lastRef.current = { code, at: now };
      setStatus(result.purpose === "MEMBER_BIND" ? "Card sent. Confirm the binding on the counter screen." : `Scan sent to ${result.purpose === "POS" ? "Point of sale" : result.purpose.toLowerCase()}.`);
      setTone("good");
      navigator.vibrate?.([45, 30, 45]);
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : "The code could not be sent.");
      setTone("bad");
      throw reason;
    } finally {
      busyRef.current = false;
    }
  }, [token]);

  const stop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    controlsRef.current?.stop();
    controlsRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    cameraActiveRef.current = false;
    setCameraActive(false);
    setTorchAvailable(false);
    setTorchOn(false);
  }, []);

  useEffect(() => { if (nfcBinding) stop(); }, [nfcBinding, stop]);

  const start = useCallback(async (automatic = false) => {
    if (cameraActiveRef.current || !videoRef.current) return;
    const constraints: MediaStreamConstraints = {
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } },
      audio: false,
    };
    try {
      const DetectorClass = (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
      if (DetectorClass) {
        const supported = DetectorClass.getSupportedFormats ? await DetectorClass.getSupportedFormats() : REQUESTED_FORMATS;
        const formats = REQUESTED_FORMATS.filter((format) => supported.includes(format));
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const track = stream.getVideoTracks()[0];
        const capabilities = track?.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean };
        setTorchAvailable(Boolean(capabilities?.torch));
        cameraActiveRef.current = true;
        setCameraActive(true);
        setDecoder(`Native decoder · ${formats.length || REQUESTED_FORMATS.length} formats`);
        setStatus("Camera live — hold the barcode steady inside the whisk line.");
        setTone("idle");
        const detector = new DetectorClass(formats.length ? { formats } : undefined);
        let previousFrame = 0;
        const inspect = async (time: number) => {
          if (!videoRef.current || !streamRef.current) return;
          if (time - previousFrame > 180 && !busyRef.current) {
            previousFrame = time;
            try {
              const detected = await detector.detect(videoRef.current);
              if (detected[0]?.rawValue) await send(detected[0].rawValue);
            } catch { /* preserve the native camera loop */ }
          }
          frameRef.current = requestAnimationFrame(inspect);
        };
        frameRef.current = requestAnimationFrame(inspect);
        return;
      }

      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 80, delayBetweenScanSuccess: 350, tryPlayVideoTimeout: 5_000 });
      controlsRef.current = await reader.decodeFromConstraints(constraints, videoRef.current, (result) => {
        if (result?.getText()) void send(result.getText()).catch(() => {});
      });
      cameraActiveRef.current = true;
      setCameraActive(true);
      setTorchAvailable(Boolean(controlsRef.current.switchTorch));
      setDecoder("ZXing enhanced decoder · 1D + 2D");
      setStatus("Enhanced camera live — EAN, UPC, Code 128/39, QR, Data Matrix and more.");
      setTone("idle");
    } catch {
      if (!automatic) {
        setStatus("Camera access was denied or unavailable. You can still type or use a Bluetooth scanner below.");
        setTone("bad");
      }
      stop();
    }
  }, [send, stop]);

  useEffect(() => {
    let cancelled = false;
    const connect = async () => {
      try {
        const result = await apiRequest<{ connected: boolean; label: string; purpose: ScannerPurpose }>("/api/mobile-scans", { method: "POST", body: JSON.stringify({ token, action: "CONNECT" }) });
        if (cancelled) return;
        setPaired(true);
        setNfcBinding(result.purpose === "MEMBER_BIND");
        setStatus(`Connected automatically to ${result.label} · ${result.purpose === "POS" ? "Point of sale" : result.purpose.toLowerCase()}.`);
        setTone("good");
        try {
          const permission = await navigator.permissions?.query({ name: "camera" as PermissionName });
          if (permission?.state === "granted" && result.purpose !== "MEMBER_BIND") void start(true);
        } catch { /* camera permission APIs vary by browser */ }
      } catch (reason) {
        if (cancelled) return;
        setStatus(reason instanceof Error ? reason.message : "This scanner pass could not connect.");
        setTone("bad");
      }
    };
    void connect();
    return () => { cancelled = true; stop(); };
  }, [start, stop, token]);

  async function toggleTorch() {
    try {
      const next = !torchOn;
      if (controlsRef.current?.switchTorch) await controlsRef.current.switchTorch(next);
      else {
        const track = streamRef.current?.getVideoTracks()[0];
        if (track) await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      }
      setTorchOn(next);
    } catch {
      setStatus("This camera could not change its torch setting.");
      setTone("bad");
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const code = String(new FormData(target).get("code") || "");
    void send(code).then(() => target.reset()).catch(() => {});
  }

  return <main className="mobile-scan-page">
    <header className="mobile-scan-brand"><span>{branding.workspaceLogoDataUrl ? <img src={branding.workspaceLogoDataUrl} alt={`${branding.businessName} logo`} /> : <Sprout />}<b>{branding.businessName}</b></span><small>24-HOUR SCANNER PASS</small></header>
    <section className={`scanner-pass scanner-${tone}`}>
      <div className="scanner-pass-edge" aria-hidden="true" />
      <div className="scanner-pass-title"><span>REMOTE COUNTER · {paired ? "AUTO-CONNECTED" : "PAIRING"}</span><h1>Turn this phone<br />into a scanner.</h1><p>No account data is exposed. The pass sends barcode values and protected NFC fingerprints only; it expires or closes immediately when revoked.</p></div>
      {!nfcBinding ? <section className="scanner-lane barcode-lane"><header><span className="eyebrow">BARCODE SCANNER</span><h2>Camera / USB / Bluetooth</h2><p>Only barcode and QR values are sent to the linked counter.</p></header><div className="camera-stage">
        <video ref={videoRef} muted playsInline />
        <div className="scan-frame"><i /><i /><i /><i /><b /></div>
        {!cameraActive ? <div className="camera-placeholder"><ScanBarcode /><span>{paired ? "Counter paired · camera ready" : "Connecting…"}</span></div> : null}
        {torchAvailable && cameraActive ? <button className={`torch-button ${torchOn ? "active" : ""}`} onClick={() => void toggleTorch()} aria-label={torchOn ? "Turn torch off" : "Turn torch on"}><Flashlight /></button> : null}
      </div>
      <button className="button button-primary mobile-camera-button" onClick={() => cameraActive ? stop() : void start()} disabled={!paired}>{cameraActive ? <CameraOff /> : <Camera />}{cameraActive ? "Stop camera" : paired ? "Start camera" : "Pairing…"}</button>
      <div className="decoder-label"><Radio />{decoder}</div>
      <form className="manual-scan" onSubmit={submit}><label><Keyboard /><input name="code" autoCapitalize="characters" autoComplete="off" placeholder="Type or scan a barcode" required /></label><button disabled={!paired}>Send barcode</button></form></section> : null}
      <section className={`scanner-lane nfc-lane ${nfcBinding ? "nfc-lane-primary" : ""}`}><header><span className="eyebrow">NFC CARD READER</span><h2>Tap-to-read NFC</h2><p>{nfcBinding ? "Tap an existing card and confirm its member on the counter. This same reader stays open for your next card." : "Use this reader for Members and POS. It stays on while this page is open."}</p></header><NfcControl autoStart alwaysOn onRead={send} onGenericRead={send} disabled={!paired} /></section>
      <div className={`scanner-status ${tone}`} aria-live="polite">{tone === "good" ? <CheckCircle2 /> : <span className="scanner-status-dot" />}<span>{status}</span></div>
      <footer><span>PASS VALIDITY</span><strong>Up to 24 hours</strong><i /></footer>
    </section>
  </main>;
}
