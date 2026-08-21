"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { Download, FileJson, ImagePlus, Palette, Plus, Save, Upload, X } from "lucide-react";
import { InvoicePaper, type InvoicePaperDocument } from "@/components/invoice-paper";
import { apiRequest, Modal, Notice, useNotice } from "@/components/ui";
import {
  DEFAULT_INVOICE_TEMPLATE,
  INVOICE_LAYOUTS,
  INVOICE_PAPER_TONES,
  type InvoiceTemplateInput,
  type InvoiceTemplateRecord,
} from "@/lib/invoice-templates";

type TemplateDraft = InvoiceTemplateInput & { _id?: string };

const previewDocument: InvoicePaperDocument = {
  invoiceNo: "INV-PREVIEW",
  status: "DRAFT",
  createdAt: new Date(),
  dueDate: new Date(Date.now() + 14 * 86400000),
  customerName: "Uji Tea Studio",
  customerEmail: "accounts@example.com",
  customerAddress: "27 Tea Room Lane · Singapore",
  customerReference: "WHOLESALE / AUG",
  items: [
    { description: "Ceremonial matchā · 30g", quantity: 4, unitPrice: 46.9, lineTotal: 187.6 },
    { description: "Purple bamboo chasen", quantity: 2, unitPrice: 18.9, lineTotal: 37.8 },
  ],
  subtotal: 225.4,
  taxRate: 9,
  tax: 20.29,
  total: 245.69,
  notes: "Thank you for sharing our tea with your guests.",
  businessSnapshot: { businessName: "Kōn-Kōn Matchā", registrationNo: "2026XXXXXX", email: "hello@konkonmatcha.com", phone: "+65 6000 0000", address: "Singapore", taxName: "GST" },
};

function draftFrom(template?: InvoiceTemplateRecord): TemplateDraft {
  return template ? {
    _id: template._id,
    name: template.name,
    layout: template.layout,
    accentColor: template.accentColor,
    paperTone: template.paperTone,
    logoDataUrl: template.logoDataUrl,
    headerText: template.headerText,
    documentTitle: template.documentTitle,
    footerText: template.footerText,
    paymentInstructions: template.paymentInstructions,
    termsDays: template.termsDays,
    showRegistrationNo: template.showRegistrationNo,
    showTaxBreakdown: template.showTaxBreakdown,
    showNotes: template.showNotes,
    isDefault: template.isDefault,
  } : { ...DEFAULT_INVOICE_TEMPLATE, name: "New invoice template", isDefault: false };
}

export function InvoiceTemplateStudio({ open, templates, initialTemplateId, onClose, onChanged }: {
  open: boolean;
  templates: InvoiceTemplateRecord[];
  initialTemplateId?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<TemplateDraft>(() => draftFrom(templates[0]));
  const [busy, setBusy] = useState(false);
  const wasOpen = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const { notice, show } = useNotice();

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (!wasOpen.current && templates.length) {
      const initialTemplate = templates.find((template) => template._id === initialTemplateId)
        || templates.find((template) => template.isDefault)
        || templates[0];
      setDraft(draftFrom(initialTemplate));
      wasOpen.current = true;
    }
  }, [open, templates, initialTemplateId]);

  function update<K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const { _id, ...payload } = draft;
      const saved = await apiRequest<InvoiceTemplateRecord>("/api/invoice-templates", { method: _id ? "PATCH" : "POST", body: JSON.stringify(_id ? { id: _id, ...payload } : payload) });
      setDraft(draftFrom(saved));
      await onChanged();
      show(_id ? "Template changes saved." : "Invoice template added.");
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not save the template.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function importTemplate(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 100_000) return show("Template JSON must be under 100 KB.", "error");
    try {
      const raw = JSON.parse(await file.text()) as Partial<InvoiceTemplateInput>;
      setDraft({ ...DEFAULT_INVOICE_TEMPLATE, ...raw, _id: undefined, name: typeof raw.name === "string" ? raw.name : "Imported invoice template", isDefault: false });
      show("Template imported. Review it, then save.");
    } catch {
      show("This file is not valid template JSON.", "error");
    }
  }

  async function uploadLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 250_000) {
      return show("Use a PNG, JPEG or WebP logo under 250 KB.", "error");
    }
    const reader = new FileReader();
    reader.onload = () => update("logoDataUrl", String(reader.result || ""));
    reader.onerror = () => show("The logo could not be read.", "error");
    reader.readAsDataURL(file);
  }

  function exportTemplate() {
    const { _id: _ignored, ...payload } = draft;
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.name.toLocaleLowerCase("en-SG").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "invoice-template"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return <Modal open={open} onClose={onClose} title="Invoice template studio" kicker="PAPER & BRAND">
    {notice ? <Notice {...notice} /> : null}
    <div className="template-studio">
      <aside className="template-shelf">
        <header><div><Palette size={18} /><span>Template shelf</span></div><button type="button" onClick={() => setDraft(draftFrom())}><Plus size={15} />New</button></header>
        <div className="template-shelf-list">{templates.map((template) => <button type="button" className={draft._id === template._id ? "active" : ""} key={template._id} onClick={() => setDraft(draftFrom(template))}><i style={{ background: template.accentColor }} /><span><strong>{template.name}</strong><small>{template.layout.toLocaleLowerCase()} {template.isDefault ? "· default" : ""}</small></span></button>)}</div>
        <footer>
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={importTemplate} />
          <button type="button" onClick={() => importRef.current?.click()}><Upload size={15} />Import JSON</button>
          <button type="button" onClick={exportTemplate}><Download size={15} />Export JSON</button>
        </footer>
      </aside>

      <form className="template-editor" onSubmit={save}>
        <div className="template-editor-scroll">
          <section><span className="eyebrow">IDENTITY</span><div className="form-grid two"><label className="field"><span>Template name</span><input value={draft.name} onChange={(event) => update("name", event.target.value)} required /></label><label className="field"><span>Document title</span><input value={draft.documentTitle} onChange={(event) => update("documentTitle", event.target.value)} required /></label></div><label className="field"><span>Header line</span><input value={draft.headerText} onChange={(event) => update("headerText", event.target.value)} placeholder="Business name or collection" /></label></section>
          <section><span className="eyebrow">PAPER</span><div className="form-grid two"><label className="field"><span>Layout</span><select value={draft.layout} onChange={(event) => update("layout", event.target.value as InvoiceTemplateInput["layout"])}>{INVOICE_LAYOUTS.map((layout) => <option key={layout}>{layout}</option>)}</select></label><label className="field"><span>Paper tone</span><select value={draft.paperTone} onChange={(event) => update("paperTone", event.target.value as InvoiceTemplateInput["paperTone"])}>{INVOICE_PAPER_TONES.map((tone) => <option key={tone}>{tone}</option>)}</select></label></div><label className="field colour-field"><span>Accent colour</span><div><input type="color" value={draft.accentColor} onChange={(event) => update("accentColor", event.target.value)} /><input value={draft.accentColor} pattern="#[0-9A-Fa-f]{6}" onChange={(event) => update("accentColor", event.target.value)} /></div></label><input ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={uploadLogo} /><div className="logo-upload"><button type="button" onClick={() => logoRef.current?.click()}><ImagePlus size={17} />{draft.logoDataUrl ? "Replace logo" : "Upload logo"}</button>{draft.logoDataUrl ? <button type="button" className="remove-logo" onClick={() => update("logoDataUrl", "")}><X size={14} />Remove</button> : <span>PNG, JPEG or WebP · 250 KB max</span>}</div></section>
          <section><span className="eyebrow">TERMS</span><label className="field"><span>Payment instructions</span><textarea rows={3} value={draft.paymentInstructions} onChange={(event) => update("paymentInstructions", event.target.value)} /></label><div className="form-grid two"><label className="field"><span>Default due days</span><input type="number" min="0" max="365" value={draft.termsDays} onChange={(event) => update("termsDays", Number(event.target.value))} /></label><label className="field"><span>Footer message</span><input value={draft.footerText} onChange={(event) => update("footerText", event.target.value)} /></label></div></section>
          <section className="template-toggles"><label className="check-row"><input type="checkbox" checked={draft.showTaxBreakdown} onChange={(event) => update("showTaxBreakdown", event.target.checked)} /><span><strong>Show tax breakdown</strong><small>Display tax as a separate total.</small></span></label><label className="check-row"><input type="checkbox" checked={draft.showNotes} onChange={(event) => update("showNotes", event.target.checked)} /><span><strong>Show invoice notes</strong><small>Include customer-facing notes.</small></span></label><label className="check-row"><input type="checkbox" checked={draft.showRegistrationNo} onChange={(event) => update("showRegistrationNo", event.target.checked)} /><span><strong>Show registration number</strong><small>Use the workspace business profile.</small></span></label><label className="check-row"><input type="checkbox" checked={draft.isDefault} onChange={(event) => update("isDefault", event.target.checked)} /><span><strong>Default template</strong><small>Preselect this for new invoices.</small></span></label></section>
        </div>
        <footer><button type="button" className="button button-secondary" onClick={onClose}>Close</button><button className="button button-primary" disabled={busy}><Save size={16} />{busy ? "Saving…" : draft._id ? "Save changes" : "Add template"}</button></footer>
      </form>

      <aside className="template-proof"><header><FileJson size={15} /><span>LIVE PAPER PROOF</span></header><div><InvoicePaper document={{ ...previewDocument, dueDate: new Date(Date.now() + draft.termsDays * 86400000) }} template={draft} compact /></div></aside>
    </div>
  </Modal>;
}
