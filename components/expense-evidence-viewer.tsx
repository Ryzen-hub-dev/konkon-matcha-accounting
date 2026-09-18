"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Eye, FileArchive, ImageIcon, LoaderCircle, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui";
import { attachmentPreviewKind } from "@/lib/attachment-files";

export type ExpenseAttachment = {
  _id: string;
  claimId: string;
  originalName: string;
  mimeType: string;
  originalSize: number;
  storedSize: number;
  encoding: string;
  createdAt: string;
};

type ErrorBody = { error?: string };

function readableSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ExpenseEvidenceGallery({ files, removable = false, removingId = "", onRemove }: { files: ExpenseAttachment[]; removable?: boolean; removingId?: string; onRemove?: (file: ExpenseAttachment) => void }) {
  const [selected, setSelected] = useState<ExpenseAttachment | null>(null);
  const [objectUrl, setObjectUrl] = useState("");
  const [textContent, setTextContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState("");
  const [mediaFailure, setMediaFailure] = useState(false);
  const kind = useMemo(() => selected ? attachmentPreviewKind(selected.mimeType) : "DOWNLOAD", [selected]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    let nextObjectUrl = "";
    setObjectUrl("");
    setTextContent("");
    setFailure("");
    setMediaFailure(false);
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/expense-attachments/${selected._id}`, {
          credentials: "same-origin",
          headers: { Accept: selected.mimeType },
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as ErrorBody | null;
          throw new Error(body?.error || `The evidence could not be opened (${response.status}).`);
        }
        const blob = await response.blob();
        if (blob.size !== selected.originalSize) throw new Error("The evidence size did not match its protected record.");
        if (kind === "TEXT") setTextContent(await blob.text());
        else {
          nextObjectUrl = URL.createObjectURL(blob);
          setObjectUrl(nextObjectUrl);
        }
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) setFailure(reason instanceof Error ? reason.message : "The evidence could not be opened.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      controller.abort();
      if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
    };
  }, [kind, selected]);

  return <>
    {files.map(file => <span className="evidence-file" key={file._id}>
      <button className="button button-quiet evidence-open" type="button" onClick={() => setSelected(file)} title={`View ${file.originalName}`}>
        <Eye size={14} />
        <span>{file.originalName}<small>{readableSize(file.originalSize)} · lossless</small></span>
      </button>
      {removable && onRemove ? <button className="evidence-remove" type="button" disabled={Boolean(removingId)} onClick={() => onRemove(file)} aria-label={`Remove ${file.originalName} from this draft`} title="Remove from draft">{removingId === file._id ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}</button> : null}
    </span>)}
    <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.originalName || "Evidence preview"} kicker="PROTECTED EVIDENCE">
      {selected ? <section className="evidence-preview">
        <header>
          <span><FileArchive size={15} />{selected.mimeType || "File"}</span>
          <span>{readableSize(selected.originalSize)} original · integrity checked</span>
        </header>
        <div className={`evidence-preview-stage evidence-preview-${kind.toLowerCase()}`}>
          {loading ? <div className="evidence-preview-state"><LoaderCircle className="spin" /><strong>Decrypting and checking the original…</strong><small>The private repository is read only by the server.</small></div> : null}
          {!loading && failure ? <div className="evidence-preview-state evidence-preview-error"><AlertTriangle /><strong>Preview unavailable</strong><small>{failure}</small><button type="button" className="button button-secondary" onClick={() => { const current = selected; setSelected(null); window.setTimeout(() => setSelected(current)); }}>Try again</button></div> : null}
          {!loading && !failure && kind === "IMAGE" && objectUrl && !mediaFailure ? <img src={objectUrl} alt={selected.originalName} onError={() => setMediaFailure(true)} /> : null}
          {!loading && !failure && kind === "IMAGE" && mediaFailure ? <div className="evidence-preview-state evidence-preview-error"><ImageIcon /><strong>This browser cannot display this image format</strong><small>HEIC/HEIF support varies by device. The protected original is intact and can still be downloaded.</small></div> : null}
          {!loading && !failure && kind === "PDF" && objectUrl ? <iframe src={objectUrl} title={selected.originalName} sandbox="" /> : null}
          {!loading && !failure && kind === "TEXT" ? <pre>{textContent}</pre> : null}
          {!loading && !failure && kind === "DOWNLOAD" ? <div className="evidence-preview-state"><FileArchive /><strong>No browser preview is available</strong><small>Download the integrity-checked original to open it in its native application.</small></div> : null}
        </div>
        <footer>
          <span>Viewing and downloading are recorded in the audit trail.</span>
          <a className="button button-primary" href={`/api/expense-attachments/${selected._id}?download=1`} download><Download size={15} />Download original</a>
        </footer>
      </section> : null}
    </Modal>
  </>;
}
