import type { Db } from "mongodb";

const GIB = 1024 ** 3;

export const MANAGED_STORAGE_MAX_BYTES = 10 * GIB;
export const MANAGED_STORAGE_WARNING_BYTES = 8 * GIB;
export const MANAGED_STORAGE_SAFETY_BYTES = 512 * 1024 ** 2;
export const MANAGED_STORAGE_UPLOAD_LIMIT_BYTES =
  MANAGED_STORAGE_MAX_BYTES - MANAGED_STORAGE_SAFETY_BYTES;

export type ManagedStorageState = "HEALTHY" | "WARNING" | "BLOCKED";

export type ManagedStorageUsage = {
  usedBytes: number;
  fileCount: number;
  maxBytes: number;
  warningAtBytes: number;
  uploadLimitBytes: number;
  safetyReserveBytes: number;
  availableForUploadsBytes: number;
  percentUsed: number;
  state: ManagedStorageState;
  categories: {
    expenseEvidenceBytes: number;
    expenseEvidenceFiles: number;
    orderFileBytes: number;
    orderFileCount: number;
  };
};

export class ManagedStorageQuotaError extends Error {
  constructor() {
    super(
      "The managed evidence store reached its safe 10 GB limit. Existing records remain available, but the Owner must archive storage before another file can be uploaded.",
    );
    this.name = "ManagedStorageQuotaError";
  }
}

export function managedStorageState(usedBytes: number) {
  const used = Math.max(0, Number.isFinite(usedBytes) ? usedBytes : 0);
  const state: ManagedStorageState =
    used >= MANAGED_STORAGE_UPLOAD_LIMIT_BYTES
      ? "BLOCKED"
      : used >= MANAGED_STORAGE_WARNING_BYTES
        ? "WARNING"
        : "HEALTHY";
  return {
    usedBytes: used,
    maxBytes: MANAGED_STORAGE_MAX_BYTES,
    warningAtBytes: MANAGED_STORAGE_WARNING_BYTES,
    uploadLimitBytes: MANAGED_STORAGE_UPLOAD_LIMIT_BYTES,
    safetyReserveBytes: MANAGED_STORAGE_SAFETY_BYTES,
    availableForUploadsBytes: Math.max(
      0,
      MANAGED_STORAGE_UPLOAD_LIMIT_BYTES - used,
    ),
    percentUsed: Math.min(
      100,
      Math.round((used / MANAGED_STORAGE_MAX_BYTES) * 1000) / 10,
    ),
    state,
  };
}

async function categoryUsage(db: Db, collection: string) {
  const [usage] = await db
    .collection(collection)
    .aggregate<{ bytes: number; files: number }>(
      [
        {
          $match: {
            storageProvider: "GITHUB_PRIVATE",
            storedSize: { $type: "number", $gt: 0 },
          },
        },
        {
          $group: {
            _id: null,
            bytes: { $sum: "$storedSize" },
            files: { $sum: 1 },
          },
        },
        { $project: { _id: 0, bytes: 1, files: 1 } },
      ],
      { maxTimeMS: 3000 },
    )
    .toArray();
  return {
    bytes: Math.max(0, Number(usage?.bytes || 0)),
    files: Math.max(0, Number(usage?.files || 0)),
  };
}

export async function getManagedStorageUsage(
  db: Db,
): Promise<ManagedStorageUsage> {
  const [expense, orders] = await Promise.all([
    categoryUsage(db, "expenseAttachments"),
    categoryUsage(db, "onlineOrderAttachments"),
  ]);
  const state = managedStorageState(expense.bytes + orders.bytes);
  return {
    ...state,
    fileCount: expense.files + orders.files,
    categories: {
      expenseEvidenceBytes: expense.bytes,
      expenseEvidenceFiles: expense.files,
      orderFileBytes: orders.bytes,
      orderFileCount: orders.files,
    },
  };
}

export async function assertManagedStorageCapacity(db: Db, addedBytes: number) {
  const usage = await getManagedStorageUsage(db);
  if (
    !Number.isSafeInteger(addedBytes) ||
    addedBytes < 1 ||
    addedBytes > usage.availableForUploadsBytes
  ) {
    throw new ManagedStorageQuotaError();
  }
  return usage;
}
