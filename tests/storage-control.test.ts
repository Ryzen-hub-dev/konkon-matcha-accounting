import assert from "node:assert/strict";
import test from "node:test";
import {
  MANAGED_STORAGE_MAX_BYTES,
  MANAGED_STORAGE_SAFETY_BYTES,
  MANAGED_STORAGE_UPLOAD_LIMIT_BYTES,
  MANAGED_STORAGE_WARNING_BYTES,
  managedStorageState,
} from "../lib/storage-control";

test("managed storage warns before uploads reach the safety ceiling", () => {
  assert.equal(managedStorageState(0).state, "HEALTHY");
  assert.equal(
    managedStorageState(MANAGED_STORAGE_WARNING_BYTES).state,
    "WARNING",
  );
  assert.equal(
    managedStorageState(MANAGED_STORAGE_UPLOAD_LIMIT_BYTES).state,
    "BLOCKED",
  );
});

test("managed storage preserves a 512 MiB reserve below the 10 GiB cap", () => {
  assert.equal(
    MANAGED_STORAGE_MAX_BYTES - MANAGED_STORAGE_UPLOAD_LIMIT_BYTES,
    MANAGED_STORAGE_SAFETY_BYTES,
  );
  const state = managedStorageState(MANAGED_STORAGE_UPLOAD_LIMIT_BYTES - 1);
  assert.equal(state.availableForUploadsBytes, 1);
  assert.equal(state.state, "WARNING");
  assert.equal(managedStorageState(MANAGED_STORAGE_MAX_BYTES * 2).percentUsed, 100);
});
