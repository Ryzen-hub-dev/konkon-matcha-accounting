"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { Download, ImagePlus, Palette, Plus, ReceiptText, Save, Upload, X } from "lucide-react";
import { ReceiptPaper, type ReceiptPaperDocument } from "@/components/receipt-paper";
import { apiRequest, Modal, Notice, useNotice } from "@/components/ui";
import {
  DEFAULT_RECEIPT_TEMPLATE,
  RECEIPT_DENSITIES,
  RECEIPT_PAPER_WIDTHS,
  type ReceiptTemplateInput,
  type ReceiptTemplateRecord,
} from "@/lib/receipt-templates";

type TemplateDraft = ReceiptTemplateInput & { _id?: string };

const previewReceipt: ReceiptPaperDocument = {
  receiptNo: "KKM-PREVIEW",
  createdAt: new Date(),
  cashierName: "Mei Lin",
  memberName: "Tea Club Member",
  memberNo: "MEM-0188",
  pointsEarned: 3,
  pointsBalance: 128,
  items: [
    { sku: "MATCHA-A-30", name: "Gurēdo A Ceremonial · 30g", quantity: 1, price: 46.9, lineTotal: 46.9 },
    { sku: "DOGU-CHASEN", name: "Purple Bamboo Chasen", quantity: 1, price: 18.9, lineTotal: 18.9 },
  ],
  subtotal: 65.8,
  discount: 5,
  taxRate: 9,
  taxMode: "INCLUSIVE",
  tax: 5.02,
  total: 60.8,
  paymentMethod: "CASH",
  tenderedAmount: 70,
  changeDue: 9.2,
  businessSnapshot: { businessName: "Kōn-Kōn Matchā", registrationNo: "2026XXXXXX", email: "hello@konkonmatcha.com", phone: "+65 6000 0000", address: "Singapore", currency: "SGD", taxName: "GST" },
};

function draftFrom(template?: ReceiptTemplateRecord): TemplateDraft {
  return template ? {
    _id: template._id,
    name: template.name,
    paperWidth: template.paperWidth,
    density: template.density,
    accentColor: template.accentColor,
    logoDataUrl: template.logoDataUrl,
    receiptTitle: template.receiptTitle,
    headerText: template.headerText,
    thankYouText: template.thankYouText,
    footerText: template.footerText,
    returnPolicy: template.returnPolicy,
    website: template.website,
    showBusinessAddress: template.showBusinessAddress,
    showRegistrationNo: template.showRegistrationNo,
    showTaxBreakdown: template.showTaxBreakdown,
    showSku: template.showSku,
    showCashier: template.showCashier,
    showMember: template.showMember,
    showPaymentDetails: template.showPaymentDetails,
    showPoints: template.showPoints,
    isDefault: template.isDefault,
  } : { ...DEFAULT_RECEIPT_TEMPLATE, name: "New receipt template", isDefault: false };
}

export function ReceiptTemplateStudio({ open, templates, initialTemplateId, onClose, onChanged }: {
  open: boolean;
  templates: ReceiptTemplateRecord[];
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
      const initial = templates.find((template) => template._id === initialTemplateId)
        || templates.find((template) => template.isDefault)
        || templates[0];
      setDraft(draftFrom(initial));
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
      const saved = await apiRequest<ReceiptTemplateRecord>("/api/receipt-templates", {
        method: _id ? "PATCH" : "POST",
        body: JSON.stringify(_id ? { id: _id, ...payload } : payload),
      });
      setDraft(draftFrom(saved));
      await onChanged();
      show(_id ? "Receipt template changes saved." : "Receipt template added.");
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not save the receipt template.", "error");
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
      const raw = JSON.parse(await file.text()) as Partial<ReceiptTemplateInput>;
      setDraft({ ...DEFAULT_RECEIPT_TEMPLATE, ...raw, _id: undefined, name: typeof raw.name === "string" ? raw.name : "Imported receipt template", isDefault: false });
      show("Template imported. Review it, then save.");
    } catch {
      show("This file is not valid receipt template JSON.", "error");
    }
  }

  function uploadLogo(event: ChangeEvent<HTMLInputElement>) {
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
    link.download = `${draft.name.toLocaleLowerCase("en-SG").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "receipt-template"}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const toggles: Array<{ key: keyof ReceiptTemplateInput; label: string; detail: string }> = [
    { key: "showTaxBreakdown", label: "Tax breakdown", detail: "Show tax rate and tax amount." },
    { key: "showSku", label: "Product SKU", detail: "Useful for exchanges and stock checks." },
    { key: "showCashier", label: "Cashier name", detail: "Identify who completed the sale." },
    { key: "showMember", label: "Member details", detail: "Show member name and number." },
    { key: "showPaymentDetails", label: "Payment details", detail: "Show tender, reference and change." },
    { key: "showPoints", label: "Reward points", detail: "Show points earned and new balance." },
    { key: "showBusinessAddress", label: "Business address", detail: "Print the workspace address." },
    { key: "showRegistrationNo", label: "Registration number", detail: "Print the legal registration number." },
  ];

  return <Modal open={open} onClose={onClose} title="Receipt template studio" kicker="THERMAL PAPER & BRAND">
    {notice ? <Notice {...notice} /> : null}
    <div className="template-studio receipt-template-studio">
      <aside className="template-shelf">
        <header><div><Palette size={18} /><span>Template shelf</span></div><button type="button" onClick={() => setDraft(draftFrom())}><Plus size={15} />New</button></header>
        <div className="template-shelf-list">{templates.map((template) => <button type="button" className={draft._id === template._id ? "active" : ""} key={template._id} onClick={() => setDraft(draftFrom(template))}><i style={{ background: template.accentColor }} /><span><strong>{template.name}</strong><small>{template.paperWidth} · {template.density.toLocaleLowerCase()} {template.isDefault ? "· default" : ""}</small></span></button>)}</div>
        <footer><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={importTemplate} /><button type="button" onClick={() => importRef.current?.click()}><Upload size={15} />Import JSON</button><button type="button" onClick={exportTemplate}><Download size={15} />Export JSON</button></footer>
      </aside>

      <form className="template-editor" onSubmit={save}>
        <div className="template-editor-scroll">
          <section><span className="eyebrow">IDENTITY</span><div className="form-grid two"><label className="field"><span>Template name</span><input value={draft.name} onChange={(event) => update("name", event.target.value)} required /></label><label className="field"><span>Receipt title</span><input value={draft.receiptTitle} onChange={(event) => update("receiptTitle", event.target.value)} required /></label></div><label className="field"><span>Header line</span><input value={draft.headerText} onChange={(event) => update("headerText", event.target.value)} /></label></section>
          <section><span className="eyebrow">THERMAL PAPER</span><div className="form-grid two"><label className="field"><span>Paper width</span><select value={draft.paperWidth} onChange={(event) => update("paperWidth", event.target.value as ReceiptTemplateInput["paperWidth"])}>{RECEIPT_PAPER_WIDTHS.map((width) => <option key={width}>{width}</option>)}</select></label><label className="field"><span>Spacing</span><select value={draft.density} onChange={(event) => update("density", event.target.value as ReceiptTemplateInput["density"])}>{RECEIPT_DENSITIES.map((density) => <option key={density}>{density}</option>)}</select></label></div><label className="field colour-field"><span>Screen accent</span><div><input type="color" value={draft.accentColor} onChange={(event) => update("accentColor", event.target.value)} /><input value={draft.accentColor} pattern="#[0-9A-Fa-f]{6}" onChange={(event) => update("accentColor", event.target.value)} /></div></label><input ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={uploadLogo} /><div className="logo-upload"><button type="button" onClick={() => logoRef.current?.click()}><ImagePlus size={17} />{draft.logoDataUrl ? "Replace logo" : "Upload logo"}</button>{draft.logoDataUrl ? <button type="button" className="remove-logo" onClick={() => update("logoDataUrl", "")}><X size={14} />Remove</button> : <span>PNG, JPEG or WebP · 250 KB max</span>}</div></section>
          <section><span className="eyebrow">CUSTOMER MESSAGE</span><label className="field"><span>Thank-you message</span><input value={draft.thankYouText} onChange={(event) => update("thankYouText", event.target.value)} /></label><label className="field"><span>Return or exchange policy</span><textarea rows={3} value={draft.returnPolicy} onChange={(event) => update("returnPolicy", event.target.value)} /></label><div className="form-grid two"><label className="field"><span>Website</span><input value={draft.website} onChange={(event) => update("website", event.target.value)} /></label><label className="field"><span>Footer line</span><input value={draft.footerText} onChange={(event) => update("footerText", event.target.value)} /></label></div></section>
          <section className="template-toggles">{toggles.map((toggle) => <label className="check-row" key={toggle.key}><input type="checkbox" checked={Boolean(draft[toggle.key])} onChange={(event) => update(toggle.key, event.target.checked as never)} /><span><strong>{toggle.label}</strong><small>{toggle.detail}</small></span></label>)}<label className="check-row"><input type="checkbox" checked={draft.isDefault} onChange={(event) => update("isDefault", event.target.checked)} /><span><strong>Default template</strong><small>Preselect this at the register.</small></span></label></section>
        </div>
        <footer><button type="button" className="button button-secondary" onClick={onClose}>Close</button><button className="button button-primary" disabled={busy}><Save size={16} />{busy ? "Saving…" : draft._id ? "Save changes" : "Add template"}</button></footer>
      </form>

      <aside className="template-proof receipt-proof"><header><ReceiptText size={15} /><span>LIVE THERMAL PROOF</span></header><div><ReceiptPaper document={previewReceipt} template={draft} compact /></div></aside>
    </div>
  </Modal>;
}
