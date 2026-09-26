"use client";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "./ui";
import { QrImage } from "./qr-image";
import { NfcControl } from "./nfc-control";
import { RemoteNfcBinding } from "./remote-nfc-binding";
import { printReceipt } from "@/lib/print-receipt";
import { useBusiness } from "@/components/business-context";

type Card = { _id: string; label: string; tier: string; accentColor: string; status: "ACTIVE" | "SUSPENDED" | "VOID" | "DELETED"; last4: string; kind?: "ISSUED" | "BOUND"; bindingSource?: "NFC_SERIAL" | "NDEF_DIGEST" };
export function MemberCardsManager({ memberId, memberName, canWrite = false }: { memberId: string; memberName: string; canWrite?: boolean }) {
  const { profile } = useBusiness();
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  const [credential, setCredential] = useState("");
  const [writerUrl, setWriterUrl] = useState("");
  const [editing, setEditing] = useState<Card | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const load = useCallback(async () => { const records = await apiRequest<Card[]>(`/api/member-cards?memberId=${memberId}`); setCards(records); }, [memberId]);
  useEffect(() => { void load().catch(reason => setError(reason.message)); }, [load]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); setBusy(true); setError("");
    try { await apiRequest("/api/member-cards", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ ...data, ...(editing ? { id: editing._id } : { memberId, clientRequestId: requestId.current }) }) }); requestId.current = crypto.randomUUID(); setEditing(null); form.reset(); setSelected(null); setCredential(""); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save this card."); } finally { setBusy(false); }
  }
  async function change(card: Card, status: Card["status"]) {
    if (busy) return;
    if (["VOID", "DELETED"].includes(status) && !confirm(`${status === "VOID" ? "Void" : "Delete"} ${card.label}? Its QR and NFC credential will stop working. Membership and transaction history stay available.`)) return;
    setBusy(true); setError("");
    try { await apiRequest("/api/member-cards", { method: status === "DELETED" ? "DELETE" : "PATCH", body: JSON.stringify({ id: card._id, ...(status === "DELETED" ? {} : { status }) }) }); setSelected(null); setCredential(""); setWriterUrl(""); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not change card."); } finally { setBusy(false); }
  }
  async function reveal(card: Card) {
    setError(""); setCredential(""); setWriterUrl(""); setSelected(null);
    try { const result = await apiRequest<{ token: string }>("/api/member-cards", { method: "POST", body: JSON.stringify({ action: "REVEAL", id: card._id }) }); setSelected(card); setCredential(result.token); setWriterUrl(`${location.origin}/card-write#card=${result.token}`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open card."); }
  }
  return <section className="member-cards-manager"><header className="no-print"><span className="eyebrow">MEMBER EXCLUSIVE CARDS</span><h2>QR & NFC cards</h2><p>Each issued card can be paused or replaced independently. A card identifies a member; it does not authorize payments.</p></header>
    {error ? <p className="card-error no-print" role="alert">{error}</p> : null}
    {canWrite ? <RemoteNfcBinding key={memberId} memberId={memberId} memberName={memberName} onBound={load} /> : null}
    {canWrite ? <form className="card-style-form no-print" onSubmit={save} key={editing?._id || "new"}><label className="field"><span>Card label</span><input name="label" defaultValue={editing?.label || "Member card"} minLength={2} maxLength={60} required /></label><label className="field"><span>Membership title</span><input name="tier" defaultValue={editing?.tier || "MATCHA CLUB"} maxLength={32} required /></label><label className="field"><span>Card colour</span><input type="color" name="accentColor" defaultValue={editing?.accentColor || "#173f2a"} /></label><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : editing ? "Save card style" : "Issue a new card"}</button>{editing ? <button type="button" className="button button-secondary" onClick={() => setEditing(null)}>Cancel edit</button> : null}</form> : null}
    <div className="member-issued-cards no-print">{cards.length ? cards.map(card => <article key={card._id}><div><strong>{card.label}</strong><small>{card.kind === "BOUND" ? `Existing NFC · ${card.bindingSource === "NFC_SERIAL" ? "hardware serial" : "NDEF fingerprint"}` : `${profile.businessName} issued card`} · •••• {card.last4} · {card.status}</small></div>{canWrite ? <div className="card-actions">{card.kind !== "BOUND" && card.status === "ACTIVE" ? <button className="button button-secondary" onClick={() => void reveal(card)} disabled={busy}>QR / NFC / print</button> : null}{["ACTIVE", "SUSPENDED"].includes(card.status) ? <><button className="button button-secondary" onClick={() => setEditing(card)}>Edit style</button><button className="button button-secondary" disabled={busy} onClick={() => void change(card, card.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")}>{card.status === "ACTIVE" ? "Suspend" : "Reactivate"}</button><button className="button button-secondary" disabled={busy} onClick={() => void change(card, "VOID")}>Void</button></> : null}{card.status !== "DELETED" ? <button className="button button-secondary" disabled={busy} onClick={() => void change(card, "DELETED")}>Delete</button> : null}</div> : null}</article>) : <p>No QR / NFC cards have been issued yet.</p>}</div>
    {selected && credential ? <section className="member-credential-stage"><article className="member-exclusive-card" data-print-qr style={{ borderColor: selected.accentColor, color: selected.accentColor }}><header>{profile.workspaceLogoDataUrl ? <img src={profile.workspaceLogoDataUrl} alt={`${profile.businessName} logo`} /> : null}<span>{profile.businessName}</span></header><small>{selected.tier}</small><h2>{memberName}</h2><QrImage value={credential} label={`Member card for ${memberName}`} width={160} /><p>{selected.label} · •••• {selected.last4}</p></article><div className="no-print"><button className="button button-primary" onClick={() => void printReceipt().catch(error => setError(error.message))}>Print member card</button><NfcControl writeToken={credential} /><details><summary>Write this card using another phone</summary><p>Scan this private link with the phone camera, then tap “Write member card”.</p><QrImage value={writerUrl} label="Open the NFC card writer on a phone" width={180} /><a className="button button-secondary" href={writerUrl} target="_blank" rel="noreferrer">Open NFC writer</a></details></div></section> : null}
  </section>;
}
