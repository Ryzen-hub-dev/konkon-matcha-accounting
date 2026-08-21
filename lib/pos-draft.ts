export const POS_DRAFT_VERSION = 1;
export const POS_DRAFT_HISTORY_LIMIT = 12;

export type PosDraftLine = {
  productId: string;
  quantity: number;
  sku: string;
  name: string;
  price: number;
};

export type PosDraft = {
  version: typeof POS_DRAFT_VERSION;
  draftId: string;
  updatedAt: string;
  lines: PosDraftLine[];
  memberId: string;
  paymentMethod: string;
  tenderCurrency: string;
  manualDiscount: number;
  couponCode: string;
  saleNote: string;
  templateId: string;
};

export type PosDraftEnvelope = { active: PosDraft | null; history: PosDraft[] };

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function posDraftStorageKey(userId: string) {
  return `konkon:pos-draft:v${POS_DRAFT_VERSION}:${userId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function validDraft(value: unknown): value is PosDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<PosDraft>;
  return draft.version === POS_DRAFT_VERSION
    && typeof draft.draftId === "string"
    && /^[A-Za-z0-9-]{8,80}$/.test(draft.draftId)
    && typeof draft.updatedAt === "string"
    && Array.isArray(draft.lines)
    && draft.lines.length <= 100
    && draft.lines.every((line) => line && typeof line.productId === "string" && line.productId.length === 24 && Number.isInteger(line.quantity) && line.quantity > 0 && line.quantity <= 999);
}

export function readPosDraft(storage: StorageLike, key: string): PosDraftEnvelope {
  try {
    const parsed = JSON.parse(storage.getItem(key) || "null") as Partial<PosDraftEnvelope> | null;
    return {
      active: validDraft(parsed?.active) ? parsed.active : null,
      history: Array.isArray(parsed?.history) ? parsed.history.filter(validDraft).slice(0, POS_DRAFT_HISTORY_LIMIT) : [],
    };
  } catch {
    return { active: null, history: [] };
  }
}

export function savePosDraft(storage: StorageLike, key: string, draft: PosDraft | null) {
  const current = readPosDraft(storage, key);
  if (!draft) {
    if (current.history.length) storage.setItem(key, JSON.stringify({ active: null, history: current.history }));
    else storage.removeItem(key);
    return;
  }
  const previous = current.active;
  let history = current.history;
  if (previous && previous.draftId === draft.draftId) {
    const nextAt = new Date(draft.updatedAt).getTime();
    const lastHistoryAt = new Date(history[0]?.updatedAt || 0).getTime();
    if (!history.length || nextAt - lastHistoryAt >= 30_000) history = [previous, ...history].slice(0, POS_DRAFT_HISTORY_LIMIT);
  } else if (previous) {
    history = [previous, ...history].slice(0, POS_DRAFT_HISTORY_LIMIT);
  }
  storage.setItem(key, JSON.stringify({ active: draft, history } satisfies PosDraftEnvelope));
}

export function clearPosDraft(storage: StorageLike, key: string) {
  const current = readPosDraft(storage, key);
  storage.setItem(key, JSON.stringify({ active: null, history: current.history } satisfies PosDraftEnvelope));
}
