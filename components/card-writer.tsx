"use client";
import { useEffect, useState } from "react";
import { memberScanToken } from "@/lib/scan-codes";
import { NfcControl } from "./nfc-control";
import type { PublicBranding } from "@/lib/business-settings";
export function CardWriter({ branding }: { branding: PublicBranding }) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => { setToken(memberScanToken(new URLSearchParams(location.hash.slice(1)).get("card") || "")); history.replaceState(history.state, "", location.pathname); }, []);
  return <main className="public-receipt-page"><span className="public-brand-line">{branding.workspaceLogoDataUrl ? <img src={branding.workspaceLogoDataUrl} alt={`${branding.businessName} logo`} /> : null}<b>{branding.businessName}</b></span><span className="eyebrow">MEMBERSHIP · NFC</span><h1>Prepare an NFC card</h1><p>The card carries a random membership code. Names, identity numbers and balances are not written to it.</p>{token === null ? <p>Preparing…</p> : token ? <NfcControl writeToken={token} /> : <p role="alert">Open the full private card-writing link from the member’s card management page.</p>}<p>Keep the writing link private. Use the linked phone scanner to test the card after writing. Suspended, voided and deleted cards cannot identify a member.</p></main>;
}
