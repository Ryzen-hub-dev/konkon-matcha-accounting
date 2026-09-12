"use client";
import { useEffect, useState } from "react";
export function QrImage({ value, label, width = 180 }: { value: string; label: string; width?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    setSrc("");
    void import("qrcode").then(module => module.toDataURL(value, { errorCorrectionLevel: "M", margin: 4, width: width * 2 })).then(url => { if (active) setSrc(url); }).catch(() => {});
    return () => { active = false; };
  }, [value, width]);
  return src ? <img src={src} alt={label} width={width} height={width} style={{ maxWidth: "100%", height: "auto" }} /> : <span role="status">Preparing QR…</span>;
}
