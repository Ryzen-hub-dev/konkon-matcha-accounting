"use client";

import { ChangeEvent, DragEvent, useRef, useState } from "react";
import { ArrowDown, ArrowUp, FileUp, GripVertical, ImagePlus, Plus, Trash2 } from "lucide-react";
import {
  customBlockKey,
  templateCustomBlockSchema,
  type TemplateCustomBlock,
} from "@/lib/document-template-blocks";

type BuiltInBlock = { key: string; label: string; detail: string };

function componentId() {
  return globalThis.crypto?.randomUUID?.()
    || `block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function DocumentLayoutEditor({ builtIns, order, customBlocks, onChange, onError }: {
  builtIns: readonly BuiltInBlock[];
  order: string[];
  customBlocks: TemplateCustomBlock[];
  onChange: (order: string[], customBlocks: TemplateCustomBlock[]) => void;
  onError: (message: string) => void;
}) {
  const [dragged, setDragged] = useState("");
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const imageRef = useRef<HTMLInputElement>(null);
  const componentRef = useRef<HTMLInputElement>(null);
  const customByKey = new Map(customBlocks.map(block => [customBlockKey(block.id), block]));
  const builtInByKey = new Map(builtIns.map(block => [block.key, block]));

  function move(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || to >= order.length) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next, customBlocks);
  }

  function drop(event: DragEvent<HTMLDivElement>, target: string) {
    event.preventDefault();
    move(order.indexOf(dragged), order.indexOf(target));
    setDragged("");
  }

  function addBlock(block: TemplateCustomBlock) {
    const key = customBlockKey(block.id);
    onChange([...order, key], [...customBlocks, block]);
  }

  function addText() {
    if (!label.trim() || !text.trim()) return onError("Add a component name and text first.");
    const parsed = templateCustomBlockSchema.safeParse({
      id: componentId(), kind: "TEXT", label: label.trim(), content: text.trim(), alignment: "LEFT",
    });
    if (!parsed.success) return onError(parsed.error.issues[0]?.message || "Check the text component.");
    addBlock(parsed.data);
    setLabel("");
    setText("");
  }

  function addImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 200_000) {
      return onError("Custom images must be PNG, JPEG or WebP files under 200 KB.");
    }
    const reader = new FileReader();
    reader.onload = () => addBlock({ id: componentId(), kind: "IMAGE", label: file.name.slice(0, 60), content: String(reader.result || ""), alignment: "CENTER" });
    reader.onerror = () => onError("The custom image could not be read.");
    reader.readAsDataURL(file);
  }

  async function importComponent(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 320_000) return onError("External component JSON must be under 320 KB.");
    try {
      const raw = JSON.parse(await file.text());
      const parsed = templateCustomBlockSchema.safeParse({ ...raw, id: componentId() });
      if (!parsed.success) return onError(parsed.error.issues[0]?.message || "This component file is not valid.");
      addBlock(parsed.data);
    } catch {
      onError("This component file is not valid JSON.");
    }
  }

  function removeCustom(key: string) {
    const block = customByKey.get(key);
    if (!block) return;
    onChange(order.filter(item => item !== key), customBlocks.filter(item => item.id !== block.id));
  }

  return <section className="document-layout-builder">
    <span className="eyebrow">DRAG & BUILD</span>
    <header><div><strong>Document component order</strong><p>Drag rows or use the arrow buttons. Required accounting blocks stay present.</p></div><span>{order.length} components</span></header>
    <div className="document-layout-list">
      {order.map((key, index) => {
        const builtIn = builtInByKey.get(key);
        const custom = customByKey.get(key);
        if (!builtIn && !custom) return null;
        return <div key={key} draggable onDragStart={() => setDragged(key)} onDragOver={event => event.preventDefault()} onDrop={event => drop(event, key)}>
          <GripVertical aria-hidden="true" />
          <span><strong>{builtIn?.label || custom?.label}</strong><small>{builtIn?.detail || `${custom?.kind === "IMAGE" ? "Uploaded image" : "Custom text"} · external-safe component`}</small></span>
          <button type="button" onClick={() => move(index, index - 1)} disabled={index === 0} aria-label={`Move ${builtIn?.label || custom?.label} up`}><ArrowUp /></button>
          <button type="button" onClick={() => move(index, index + 1)} disabled={index === order.length - 1} aria-label={`Move ${builtIn?.label || custom?.label} down`}><ArrowDown /></button>
          {custom ? <button type="button" onClick={() => removeCustom(key)} aria-label={`Remove ${custom.label}`}><Trash2 /></button> : <i>LOCKED</i>}
        </div>;
      })}
    </div>
    <div className="document-component-maker">
      <label className="field"><span>Custom text name</span><input value={label} maxLength={60} onChange={event => setLabel(event.target.value)} placeholder="Delivery note" /></label>
      <label className="field"><span>Text</span><textarea rows={2} maxLength={1000} value={text} onChange={event => setText(event.target.value)} placeholder="Add document wording without HTML or scripts." /></label>
      <button type="button" className="button button-secondary" onClick={addText}><Plus size={14} />Add text</button>
      <input ref={imageRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={addImage} />
      <button type="button" className="button button-secondary" onClick={() => imageRef.current?.click()}><ImagePlus size={14} />Add image</button>
      <input ref={componentRef} type="file" accept="application/json,.json" hidden onChange={importComponent} />
      <button type="button" className="button button-secondary" onClick={() => componentRef.current?.click()}><FileUp size={14} />Import component</button>
    </div>
  </section>;
}
