"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, CheckCircle2, Keyboard, ScanBarcode, Sprout } from "lucide-react";
import { apiRequest } from "@/components/ui";

type Detector = { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> };
type DetectorConstructor = new (options?: { formats?: string[] }) => Detector;

export function MobileScanner({ token }: { token: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const lastRef = useRef({ code: "", at: 0 });
  const [cameraActive, setCameraActive] = useState(false);
  const [status, setStatus] = useState("Ready to pair with the register.");
  const [tone, setTone] = useState<"idle" | "good" | "bad">("idle");

  const send = useCallback(async (rawCode: string) => {
    const code = rawCode.trim();
    if (!code || busyRef.current) return;
    const now = Date.now();
    if (lastRef.current.code === code && now - lastRef.current.at < 1500) return;
    busyRef.current = true;
    try {
      await apiRequest("/api/mobile-scans", { method: "POST", body: JSON.stringify({ token, code }) });
      lastRef.current = { code, at: now };
      setStatus(`${code} sent to the counter.`);
      setTone("good");
      navigator.vibrate?.(70);
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : "The code could not be sent.");
      setTone("bad");
    } finally {
      window.setTimeout(() => { busyRef.current = false; }, 450);
    }
  }, [token]);

  const stop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
  }, []);

  useEffect(() => stop, [stop]);

  async function start() {
    const DetectorClass = (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
    if (!DetectorClass) {
      setStatus("This browser does not support live barcode detection. Use the manual scanner field below.");
      setTone("bad");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      if (!videoRef.current) return stop();
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraActive(true);
      setStatus("Camera active — hold a barcode inside the frame.");
      setTone("idle");
      const detector = new DetectorClass({ formats: ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code"] });
      let previousFrame = 0;
      const inspect = async (time: number) => {
        if (!videoRef.current || !streamRef.current) return;
        if (time - previousFrame > 350 && !busyRef.current) {
          previousFrame = time;
          try {
            const detected = await detector.detect(videoRef.current);
            if (detected[0]?.rawValue) await send(detected[0].rawValue);
          } catch { /* keep the camera loop alive */ }
        }
        frameRef.current = requestAnimationFrame(inspect);
      };
      frameRef.current = requestAnimationFrame(inspect);
    } catch {
      setStatus("Camera access was denied or unavailable. You can still type or use a paired scanner below.");
      setTone("bad");
      stop();
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
      <div className="scanner-pass-title"><span>REMOTE COUNTER</span><h1>Turn this phone<br />into a scanner.</h1><p>No account details are exposed. This link can only send barcode values and expires or closes when the Owner revokes access.</p></div>
      <div className="camera-stage">
        <video ref={videoRef} muted playsInline />
        <div className="scan-frame"><i /><i /><i /><i /></div>
        {!cameraActive ? <div className="camera-placeholder"><ScanBarcode /><span>Camera is off</span></div> : null}
      </div>
      <button className="button button-primary mobile-camera-button" onClick={cameraActive ? stop : start}>{cameraActive ? <CameraOff /> : <Camera />}{cameraActive ? "Stop camera" : "Start camera"}</button>
      <div className={`scanner-status ${tone}`} aria-live="polite">{tone === "good" ? <CheckCircle2 /> : <span className="scanner-status-dot" />}<span>{status}</span></div>
      <form className="manual-scan" onSubmit={submit}><label><Keyboard /><input name="code" autoCapitalize="characters" autoComplete="off" placeholder="Type or scan a code" required autoFocus /></label><button>Send</button></form>
      <footer><span>PASS VALIDITY</span><strong>Up to 24 hours</strong><i /></footer>
    </section>
  </main>;
}
