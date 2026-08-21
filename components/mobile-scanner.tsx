"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, CheckCircle2, Flashlight, Keyboard, Radio, ScanBarcode, Sprout } from "lucide-react";
import type { IScannerControls } from "@zxing/browser";
import { apiRequest } from "@/components/ui";

type Detector = { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> };
type DetectorConstructor = {
  new (options?: { formats?: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
};

const REQUESTED_FORMATS = ["code_128", "code_39", "codabar", "data_matrix", "ean_13", "ean_8", "itf", "pdf417", "qr_code", "upc_a", "upc_e"];

export function MobileScanner({ token }: { token: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const cameraActiveRef = useRef(false);
  const busyRef = useRef(false);
  const lastRef = useRef({ code: "", at: 0 });
  const [cameraActive, setCameraActive] = useState(false);
  const [paired, setPaired] = useState(false);
  const [decoder, setDecoder] = useState("Multi-format decoder ready");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [status, setStatus] = useState("Connecting to the counter automatically…");
  const [tone, setTone] = useState<"idle" | "good" | "bad">("idle");

  const send = useCallback(async (rawCode: string) => {
    const code = rawCode.trim();
    if (!code || busyRef.current) return;
    const now = Date.now();
    if (lastRef.current.code === code && now - lastRef.current.at < 1_500) return;
    busyRef.current = true;
    try {
      await apiRequest("/api/mobile-scans", { method: "POST", body: JSON.stringify({ token, code }) });
      lastRef.current = { code, at: now };
      setStatus(`${code} sent instantly to the active screen.`);
      setTone("good");
      navigator.vibrate?.([45, 30, 45]);
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : "The code could not be sent.");
      setTone("bad");
    } finally {
      window.setTimeout(() => { busyRef.current = false; }, 320);
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
        if (result?.getText()) void send(result.getText());
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
        const result = await apiRequest<{ connected: boolean; label: string; purpose: "POS" | "INVENTORY" }>("/api/mobile-scans", { method: "POST", body: JSON.stringify({ token, action: "CONNECT" }) });
        if (cancelled) return;
        setPaired(true);
        setStatus(`Connected automatically to ${result.label} · ${result.purpose === "INVENTORY" ? "Inventory" : "Point of sale"}.`);
        setTone("good");
        try {
          const permission = await navigator.permissions?.query({ name: "camera" as PermissionName });
          if (permission?.state === "granted") void start(true);
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
    void send(code).then(() => target.reset());
  }

  return <main className="mobile-scan-page">
    <header className="mobile-scan-brand"><span><Sprout />KŌN-KŌN</span><small>24-HOUR SCANNER PASS</small></header>
    <section className={`scanner-pass scanner-${tone}`}>
      <div className="scanner-pass-edge" aria-hidden="true" />
      <div className="scanner-pass-title"><span>REMOTE COUNTER · {paired ? "AUTO-CONNECTED" : "PAIRING"}</span><h1>Turn this phone<br />into a scanner.</h1><p>No account data is exposed. The pass sends barcode values only and expires or closes immediately when revoked.</p></div>
      <div className="camera-stage">
        <video ref={videoRef} muted playsInline />
        <div className="scan-frame"><i /><i /><i /><i /><b /></div>
        {!cameraActive ? <div className="camera-placeholder"><ScanBarcode /><span>{paired ? "Counter paired · camera ready" : "Connecting…"}</span></div> : null}
        {torchAvailable && cameraActive ? <button className={`torch-button ${torchOn ? "active" : ""}`} onClick={() => void toggleTorch()} aria-label={torchOn ? "Turn torch off" : "Turn torch on"}><Flashlight /></button> : null}
      </div>
      <button className="button button-primary mobile-camera-button" onClick={() => cameraActive ? stop() : void start()} disabled={!paired}>{cameraActive ? <CameraOff /> : <Camera />}{cameraActive ? "Stop camera" : paired ? "Start camera" : "Pairing…"}</button>
      <div className="decoder-label"><Radio />{decoder}</div>
      <div className={`scanner-status ${tone}`} aria-live="polite">{tone === "good" ? <CheckCircle2 /> : <span className="scanner-status-dot" />}<span>{status}</span></div>
      <form className="manual-scan" onSubmit={submit}><label><Keyboard /><input name="code" autoCapitalize="characters" autoComplete="off" placeholder="Type or scan a code" required /></label><button disabled={!paired}>Send</button></form>
      <footer><span>PASS VALIDITY</span><strong>Up to 24 hours</strong><i /></footer>
    </section>
  </main>;
}
