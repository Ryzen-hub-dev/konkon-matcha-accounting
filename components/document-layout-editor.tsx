"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, FileUp, GripVertical,
  ImagePlus, LayoutGrid, Minus, PanelTop, Plus, Quote, Rows3, Space, Trash2,
} from "lucide-react";
import {
  customBlockKey, normaliseTemplateBlockStyles, templateCustomBlockSchema,
  type TemplateBlockStyle, type TemplateCustomBlock,
} from "@/lib/document-template-blocks";

type BuiltInBlock = { key: string; label: string; detail: string; fixedWidth?: boolean };

function componentId() {
  return globalThis.crypto?.randomUUID?.()
    || `block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const STYLE_LABELS = {
  FULL: "Full", TWO_THIRDS: "2/3", HALF: "1/2", THIRD: "1/3",
  PLAIN: "Plain", OUTLINE: "Outline", TINT: "Tint", ACCENT: "Accent",
  COMPACT: "Compact", STANDARD: "Standard", RELAXED: "Relaxed",
} as const;

export function DocumentLayoutEditor({ builtIns, order, customBlocks, blockStyles, compact = false, onChange, onError }: {
  builtIns: readonly BuiltInBlock[];
  order: string[];
  customBlocks: TemplateCustomBlock[];
  blockStyles: TemplateBlockStyle[];
  compact?: boolean;
  onChange: (order: string[], customBlocks: TemplateCustomBlock[], blockStyles: TemplateBlockStyle[]) => void;
  onError: (message: string) => void;
}) {
  const [dragged, setDragged] = useState("");
  const [selected, setSelected] = useState(order[0] || "");
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const imageRef = useRef<HTMLInputElement>(null);
  const componentRef = useRef<HTMLInputElement>(null);
  const customByKey = new Map(customBlocks.map(block => [customBlockKey(block.id), block]));
  const builtInByKey = new Map(builtIns.map(block => [block.key, block]));
  const styles = useMemo(() => normaliseTemplateBlockStyles(blockStyles, order), [blockStyles, order]);
  const styleByKey = new Map(styles.map(style => [style.key, style]));
  const selectedStyle = styleByKey.get(selected);
  const selectedBuiltIn = builtInByKey.get(selected);
  const selectedCustom = customByKey.get(selected);

  useEffect(() => {
    if (!order.includes(selected)) setSelected(order[0] || "");
  }, [order, selected]);

  function commit(nextOrder = order, nextBlocks = customBlocks, nextStyles = styles) {
    const allowed = new Set(nextOrder);
    onChange(nextOrder, nextBlocks, nextStyles.filter(style => allowed.has(style.key)));
  }

  function move(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || to >= order.length) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    commit(next);
  }

  function drop(event: DragEvent<HTMLButtonElement>, target: string) {
    event.preventDefault();
    move(order.indexOf(dragged), order.indexOf(target));
    setDragged("");
  }

  function addBlock(block: TemplateCustomBlock) {
    if (customBlocks.length >= 6) return onError("A template can contain up to six custom components.");
    const key = customBlockKey(block.id);
    setSelected(key);
    commit([...order, key], [...customBlocks, block], [...styles, {
      key,
      width: "FULL",
      surface: block.kind === "CALLOUT" ? "TINT" : "PLAIN",
      spacing: block.kind === "SPACER" ? "RELAXED" : "STANDARD",
      alignment: block.alignment,
    }]);
  }

  function addText(kind: "TEXT" | "CALLOUT" = "TEXT") {
    if (!label.trim() || !text.trim()) return onError("Add a component name and text first.");
    const parsed = templateCustomBlockSchema.safeParse({
      id: componentId(), kind, label: label.trim(), content: text.trim(), alignment: "LEFT",
    });
    if (!parsed.success) return onError(parsed.error.issues[0]?.message || "Check the text component.");
    addBlock(parsed.data);
    setLabel("");
    setText("");
  }

  function addDecoration(kind: "DIVIDER" | "SPACER") {
    addBlock({ id: componentId(), kind, label: kind === "DIVIDER" ? "Section divider" : "Breathing space", content: "", alignment: "CENTER" });
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
    const nextOrder = order.filter(item => item !== key);
    setSelected(nextOrder[0] || "");
    commit(nextOrder, customBlocks.filter(item => item.id !== block.id));
  }

  function updateStyle(patch: Partial<TemplateBlockStyle>) {
    if (!selectedStyle) return;
    commit(order, customBlocks, styles.map(style => style.key === selected ? { ...style, ...patch } : style));
  }

  function applyKit(kit: "EDITORIAL" | "STUDIO" | "MINIMAL") {
    const next = styles.map((style, index) => {
      const fixed = compact || builtInByKey.get(style.key)?.fixedWidth;
      if (kit === "MINIMAL") return { ...style, width: "FULL" as const, surface: "PLAIN" as const, spacing: "COMPACT" as const };
      if (kit === "EDITORIAL") return {
        ...style,
        width: "FULL" as const,
        surface: (["HEADER", "TOTALS", "FOOTER"].includes(style.key) ? "TINT" : "PLAIN") as TemplateBlockStyle["surface"],
        spacing: "STANDARD" as const,
      };
      return {
        ...style,
        width: fixed ? "FULL" as const : (index % 3 === 1 ? "HALF" as const : "FULL" as const),
        surface: (index % 3 === 1 ? "OUTLINE" : "PLAIN") as TemplateBlockStyle["surface"],
        spacing: "RELAXED" as const,
      };
    });
    commit(order, customBlocks, next);
  }

  return <section className="document-layout-builder">
    <span className="eyebrow">VISUAL DOCUMENT BUILDER</span>
    <header><div><strong>Build on a print-safe canvas</strong><p>Drag components, select a layer and style it. Required accounting evidence remains locked.</p></div><span>{order.length} layers</span></header>
    <div className="document-layout-kits" aria-label="Professional layout kits">
      <button type="button" onClick={() => applyKit("EDITORIAL")}><PanelTop /><span><strong>Editorial</strong><small>Structured hierarchy</small></span></button>
      <button type="button" onClick={() => applyKit("STUDIO")}><LayoutGrid /><span><strong>Studio grid</strong><small>Modular composition</small></span></button>
      <button type="button" onClick={() => applyKit("MINIMAL")}><Rows3 /><span><strong>Essential</strong><small>Compact and clean</small></span></button>
    </div>
    <div className="document-builder-workbench">
      <div className="document-layer-canvas" aria-label="Document layers">
        {order.map((key, index) => {
          const builtIn = builtInByKey.get(key);
          const custom = customByKey.get(key);
          const blockStyle = styleByKey.get(key);
          if ((!builtIn && !custom) || !blockStyle) return null;
          const width = compact || builtIn?.fixedWidth ? "FULL" : blockStyle.width;
          return <button type="button" key={key}
            className={`document-layer-card layer-width-${width.toLowerCase().replace("_", "-")} layer-surface-${blockStyle.surface.toLowerCase()} ${selected === key ? "selected" : ""}`}
            draggable onClick={() => setSelected(key)} onDragStart={() => setDragged(key)}
            onDragOver={event => event.preventDefault()} onDrop={event => drop(event, key)}>
            <GripVertical aria-hidden="true" />
            <span><strong>{builtIn?.label || custom?.label}</strong><small>{builtIn?.detail || `${custom?.kind.toLocaleLowerCase()} component`}</small></span>
            <em>{builtIn ? "LOCKED DATA" : "CUSTOM"}</em><i>{index + 1}</i>
          </button>;
        })}
      </div>
      <aside className="document-layer-inspector">
        {selectedStyle ? <>
          <header><span>SELECTED LAYER</span><strong>{selectedBuiltIn?.label || selectedCustom?.label}</strong></header>
          {!compact && !selectedBuiltIn?.fixedWidth ? <label><span>Width</span><select value={selectedStyle.width} onChange={event => updateStyle({ width: event.target.value as TemplateBlockStyle["width"] })}>{(["FULL", "TWO_THIRDS", "HALF", "THIRD"] as const).map(value => <option value={value} key={value}>{STYLE_LABELS[value]}</option>)}</select></label> : <p className="document-inspector-note">This financial layer stays full width for reliable printing.</p>}
          <label><span>Surface</span><select value={selectedStyle.surface} onChange={event => updateStyle({ surface: event.target.value as TemplateBlockStyle["surface"] })}>{(["PLAIN", "OUTLINE", "TINT", "ACCENT"] as const).map(value => <option value={value} key={value}>{STYLE_LABELS[value]}</option>)}</select></label>
          <label><span>Spacing</span><select value={selectedStyle.spacing} onChange={event => updateStyle({ spacing: event.target.value as TemplateBlockStyle["spacing"] })}>{(["COMPACT", "STANDARD", "RELAXED"] as const).map(value => <option value={value} key={value}>{STYLE_LABELS[value]}</option>)}</select></label>
          <div className="document-alignment" aria-label="Text alignment">
            {(["LEFT", "CENTER", "RIGHT"] as const).map(value => <button type="button" aria-label={`Align ${value.toLocaleLowerCase()}`} className={selectedStyle.alignment === value ? "active" : ""} key={value} onClick={() => updateStyle({ alignment: value })}>{value === "LEFT" ? <AlignLeft /> : value === "CENTER" ? <AlignCenter /> : <AlignRight />}</button>)}
          </div>
          <div className="document-layer-actions">
            <button type="button" onClick={() => move(order.indexOf(selected), order.indexOf(selected) - 1)} disabled={order.indexOf(selected) === 0}><ArrowUp />Up</button>
            <button type="button" onClick={() => move(order.indexOf(selected), order.indexOf(selected) + 1)} disabled={order.indexOf(selected) === order.length - 1}><ArrowDown />Down</button>
            {selectedCustom ? <button type="button" className="danger" onClick={() => removeCustom(selected)}><Trash2 />Delete</button> : null}
          </div>
        </> : <p>Select a layer on the canvas to edit it.</p>}
      </aside>
    </div>
    <div className="document-component-library">
      <header><div><strong>Component library</strong><small>Safe building blocks—no scripts or executable HTML.</small></div></header>
      <div className="document-quick-components">
        <button type="button" onClick={() => addDecoration("DIVIDER")}><Minus /><span><strong>Divider</strong><small>Separate sections</small></span></button>
        <button type="button" onClick={() => addDecoration("SPACER")}><Space /><span><strong>Spacer</strong><small>Add breathing room</small></span></button>
        <button type="button" onClick={() => { if (!label.trim()) setLabel("Important note"); if (!text.trim()) setText("Add a short customer-facing note."); }}><Quote /><span><strong>Callout</strong><small>Prepare highlighted text</small></span></button>
        <button type="button" onClick={() => imageRef.current?.click()}><ImagePlus /><span><strong>Image</strong><small>PNG, JPEG or WebP</small></span></button>
      </div>
      <div className="document-component-maker">
        <label className="field"><span>Component name</span><input value={label} maxLength={60} onChange={event => setLabel(event.target.value)} placeholder="Delivery note" /></label>
        <label className="field"><span>Text</span><textarea rows={2} maxLength={1000} value={text} onChange={event => setText(event.target.value)} placeholder="Add document wording without HTML or scripts." /></label>
        <button type="button" className="button button-secondary" onClick={() => addText("TEXT")}><Plus size={14} />Add text</button>
        <button type="button" className="button button-secondary" onClick={() => addText("CALLOUT")}><Quote size={14} />Add callout</button>
        <input ref={imageRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={addImage} />
        <input ref={componentRef} type="file" accept="application/json,.json" hidden onChange={importComponent} />
        <button type="button" className="button button-secondary" onClick={() => componentRef.current?.click()}><FileUp size={14} />Import external component</button>
      </div>
    </div>
  </section>;
}
