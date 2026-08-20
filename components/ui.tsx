"use client";

import { ReactNode, useCallback, useState } from "react";
import { AlertCircle, Check, LoaderCircle, Plus, X } from "lucide-react";

export const money = new Intl.NumberFormat("en-SG", { style: "currency", currency: "SGD" });
export const shortDate = new Intl.DateTimeFormat("en-SG", { day: "2-digit", month: "short", year: "numeric" });
export const dateTime = new Intl.DateTimeFormat("en-SG", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({ ok: false, error: "The server returned an unreadable response." }));
  if (!response.ok || !body.ok) throw new Error(body.error || "The request failed.");
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
  const tone = ["PAID", "POSTED", "COMPLETED", "ACTIVE"].includes(value) ? "good" : ["VOID", "DISABLED", "OVERDUE"].includes(value) ? "bad" : "neutral";
  return <span className={`status-pill status-${tone}`}>{value.replaceAll("_", " ")}</span>;
}
