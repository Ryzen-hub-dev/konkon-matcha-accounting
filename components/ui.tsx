"use client";

import { ReactNode, useCallback, useState } from "react";
import { AlertCircle, Check, LoaderCircle, Plus, X } from "lucide-react";

export const money = new Intl.NumberFormat("en-SG", { style: "currency", currency: "SGD" });
export const shortDate = new Intl.DateTimeFormat("en-SG", { day: "2-digit", month: "short", year: "numeric" });
export const dateTime = new Intl.DateTimeFormat("en-SG", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

type ApiErrorBody = {
  ok?: boolean;
  error?: string;
  issues?: Record<string, string[]>;
};

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly issues?: Record<string, string[]>) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function fallbackMessage(status: number) {
  if (status === 404) return "This service endpoint is unavailable (404). The deployment may be incomplete.";
  if (status === 405) return "The server does not allow this action (405).";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status >= 500) return "The server is temporarily unavailable. Please try again.";
  return `The request failed (${status || "network error"}).`;
}

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin", headers });
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
    throw new ApiRequestError("Could not reach the server. Check your connection and try again.", 0);
  }

  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null) as (ApiErrorBody & { data?: T }) | null
    : null;

  if (!response.ok || body?.ok !== true) {
    const firstIssue = body?.issues
      ? Object.values(body.issues).flat().find((issue) => typeof issue === "string" && issue.length > 0)
      : undefined;
    const baseMessage = body?.error || fallbackMessage(response.status);
    const message = firstIssue ? `${baseMessage} ${firstIssue}` : baseMessage;
    throw new ApiRequestError(message, response.status, body?.issues);
  }
  return body.data as T;
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="page-actions">{action}</div> : null}
    </header>
  );
}

export function StatCard({ label, value, detail, tone = "matcha", icon }: { label: string; value: string; detail: string; tone?: "matcha" | "plum" | "ink" | "sand"; icon: ReactNode }) {
  return (
    <article className={`stat-card stat-${tone}`}>
      <div className="stat-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-whisk" aria-hidden="true"><i /><i /><i /><i /><i /></div>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function LoadingPanel({ label = "Whisking the numbers…" }: { label?: string }) {
  return <div className="loading-panel"><LoaderCircle className="spin" size={22} /> {label}</div>;
}

export function Modal({ open, title, kicker, children, onClose }: { open: boolean; title: string; kicker?: string; children: ReactNode; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header>
          <div>{kicker ? <span className="eyebrow">{kicker}</span> : null}<h2 id="modal-title">{title}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function Notice({ message, tone = "success" }: { message: string; tone?: "success" | "error" }) {
  return <div className={`notice notice-${tone}`} role="status">{tone === "success" ? <Check size={17} /> : <AlertCircle size={17} />}<span>{message}</span></div>;
}

export function useNotice() {
  const [notice, setNotice] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const show = useCallback((message: string, tone: "success" | "error" = "success") => {
    setNotice({ message, tone });
    window.setTimeout(() => setNotice(null), 4200);
  }, []);
  return { notice, show };
}

export function AddButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button className="button button-primary" onClick={onClick}><Plus size={17} />{children}</button>;
}

export function StatusPill({ value }: { value: string }) {
  const tone = ["PAID", "POSTED", "COMPLETED", "ACTIVE"].includes(value) ? "good" : ["VOID", "DISABLED", "OVERDUE", "REFUNDED"].includes(value) ? "bad" : "neutral";
  return <span className={`status-pill status-${tone}`}>{value.replaceAll("_", " ")}</span>;
}
