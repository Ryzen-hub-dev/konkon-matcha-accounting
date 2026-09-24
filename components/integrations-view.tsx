"use client";

import { FormEvent, useEffect, useState } from "react";
import { Bot, ExternalLink, MessageCircle, Radio, Send, ShieldCheck, Trash2 } from "lucide-react";
import { apiRequest, LoadingPanel, Notice, PageHeader, useNotice } from "@/components/ui";
import type { NotificationProvider } from "@/lib/notification-connectors";

type Connection = {
  provider: NotificationProvider;
  configured: boolean;
  endpointLast4: string;
  destinationLast4: string;
  signingSecretLast4: string;
  validatedAt: string | null;
};

const providerInfo: Record<NotificationProvider, { name: string; eyebrow: string; description: string; docs: string }> = {
  TELEGRAM: { name: "Telegram bot", eyebrow: "BOT API", description: "Send protected operational notices to one chat, group or channel.", docs: "https://core.telegram.org/bots/api" },
  FEISHU: { name: "Feishu / Lark", eyebrow: "INCOMING BOT", description: "Post plain-text notices through an official custom-bot webhook.", docs: "https://open.feishu.cn/" },
  DISCORD: { name: "Discord", eyebrow: "CHANNEL WEBHOOK", description: "Post notices to one server channel without granting broader bot permissions.", docs: "https://discord.com/developers/docs/resources/webhook" },
};

export function IntegrationsView() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [busy, setBusy] = useState<NotificationProvider | null>(null);
  const { notice, show } = useNotice();

  async function load() {
    try { setConnections(await apiRequest<Connection[]>("/api/notification-connections")); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load messaging connections.", "error"); }
  }
  useEffect(() => { void load(); }, []);

  async function connect(provider: NotificationProvider, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(provider);
    const form = new FormData(event.currentTarget);
    try {
      const saved = await apiRequest<Connection>("/api/notification-connections", {
        method: "PATCH",
        body: JSON.stringify({
          provider,
          endpoint: String(form.get("endpoint") || "") || undefined,
          destination: String(form.get("destination") || "") || undefined,
          signingSecret: String(form.get("signingSecret") || "") || undefined,
          clearSigningSecret: form.has("clearSigningSecret"),
        }),
      });
      setConnections(current => current?.map(item => item.provider === provider ? saved : item) || [saved]);
      show(`${providerInfo[provider].name} test delivered and connection saved.`);
    } catch (reason) { show(reason instanceof Error ? reason.message : `Could not connect ${providerInfo[provider].name}.`, "error"); }
    finally { setBusy(null); }
  }

  async function disconnect(provider: NotificationProvider) {
    if (busy || !window.confirm(`Disconnect ${providerInfo[provider].name}? Future notices will stop, while audit history remains.`)) return;
    setBusy(provider);
    try {
      await apiRequest("/api/notification-connections", { method: "DELETE", body: JSON.stringify({ provider }) });
      setConnections(current => current?.map(item => item.provider === provider ? { ...item, configured: false, endpointLast4: "", destinationLast4: "", signingSecretLast4: "", validatedAt: null } : item) || null);
      show(`${providerInfo[provider].name} disconnected.`);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not disconnect this channel.", "error"); }
    finally { setBusy(null); }
  }

  return <div className="page page-enter integrations-page">
    <PageHeader eyebrow="SECURE DISPATCH" title="Messaging integrations" description="Connect official Telegram, Feishu or Discord destinations. Every secret stays encrypted on the server." />
    {notice ? <Notice {...notice} /> : null}
    <section className="integration-dispatch-note"><Radio /><div><strong>Test first, then trust the route.</strong><span>Save sends one visible verification message. Workspace mode changes are delivered to every connected channel without blocking the control if a provider is offline.</span></div></section>
    {!connections ? <LoadingPanel label="Checking secure dispatch routes…" /> : <section className="integration-card-grid">{connections.map(connection => {
      const info = providerInfo[connection.provider];
      const Icon = connection.provider === "TELEGRAM" ? Send : connection.provider === "FEISHU" ? MessageCircle : Bot;
      return <form className={`panel integration-card ${connection.configured ? "is-connected" : ""}`} onSubmit={event => void connect(connection.provider, event)} key={`${connection.provider}/${connection.validatedAt || "new"}`}>
        <header><span className="integration-provider-mark"><Icon /></span><div><small>{info.eyebrow}</small><h2>{info.name}</h2><p>{info.description}</p></div><span className="integration-route-status"><i />{connection.configured ? "CONNECTED" : "OFFLINE"}</span></header>
        <div className="integration-route-line"><i /><span>ENCRYPTED ROUTE</span><i /></div>
        {connection.provider === "TELEGRAM" ? <><label className="field"><span>Bot token {connection.configured ? `· saved ending ${connection.endpointLast4}` : ""}</span><input name="endpoint" type="password" autoComplete="new-password" placeholder={connection.configured ? "Leave blank to keep saved token" : "From @BotFather"} /></label><label className="field"><span>Chat ID or @channel {connection.configured ? `· saved ending ${connection.destinationLast4}` : ""}</span><input name="destination" type="password" autoComplete="new-password" placeholder={connection.configured ? "Leave blank to keep destination" : "Example: -1001234567890"} /></label></> : <label className="field"><span>Official webhook URL {connection.configured ? `· saved ending ${connection.endpointLast4}` : ""}</span><input name="endpoint" type="password" autoComplete="new-password" placeholder={connection.configured ? "Leave blank to keep saved webhook" : connection.provider === "DISCORD" ? "https://discord.com/api/webhooks/…" : "https://open.feishu.cn/open-apis/bot/v2/hook/…"} /></label>}
        {connection.provider === "FEISHU" ? <><label className="field"><span>Signing secret {connection.signingSecretLast4 ? `· saved ending ${connection.signingSecretLast4}` : "· optional"}</span><input name="signingSecret" type="password" autoComplete="new-password" placeholder={connection.signingSecretLast4 ? "Leave blank to keep saved secret" : "Use when signature verification is enabled"} /></label>{connection.signingSecretLast4 ? <label className="check-row compact"><input name="clearSigningSecret" type="checkbox" /><span>Remove the saved signing secret</span></label> : null}</> : null}
        <p className="integration-safety"><ShieldCheck />Only the official provider host and exact webhook path are accepted. Raw secrets are never returned to this page.</p>
        <footer><button className="button button-primary" disabled={Boolean(busy)}><Send size={15} />{busy === connection.provider ? "Sending test…" : connection.configured ? "Test & save" : "Send test & connect"}</button>{connection.configured ? <button type="button" className="icon-button danger" disabled={Boolean(busy)} onClick={() => void disconnect(connection.provider)} aria-label={`Disconnect ${info.name}`} title={`Disconnect ${info.name}`}><Trash2 /></button> : null}<a href={info.docs} target="_blank" rel="noreferrer" className="integration-doc-link">Official guide <ExternalLink /></a></footer>
      </form>;
    })}</section>}
  </div>;
}
