export type AttachmentPreviewKind = "IMAGE" | "PDF" | "TEXT" | "DOWNLOAD";

export function attachmentPreviewKind(mimeType: string): AttachmentPreviewKind {
  const normalized = mimeType.trim().toLowerCase();
  if (["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(normalized)) return "IMAGE";
  if (normalized === "application/pdf") return "PDF";
  if (normalized === "text/plain") return "TEXT";
  return "DOWNLOAD";
}

export function safeAttachmentName(value: unknown) {
  return String(value || "evidence")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "-")
    .trim()
    .slice(0, 180) || "evidence";
}

export function attachmentContentDisposition(originalName: unknown, download: boolean) {
  const name = safeAttachmentName(originalName).replace(/"/g, "_");
  const ascii = name.replace(/[^\x20-\x7E]/g, "_");
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
