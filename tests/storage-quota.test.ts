import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDefaultStorageQuotaBytes,
  resolveOrganizationQuotaBytes,
} from "../src/server/storage-quota.ts";

test("explicit organization quota wins over the environment default", () => {
  process.env.NEXORA_DEFAULT_STORAGE_QUOTA_BYTES = "1073741824";
  assert.equal(resolveOrganizationQuotaBytes("500"), 500);
});

test("environment default applies only when the organization has no quota", () => {
  process.env.NEXORA_DEFAULT_STORAGE_QUOTA_BYTES = "1073741824";
  assert.equal(resolveOrganizationQuotaBytes(null), 1073741824);
});

test("unset default means no cap", () => {
  delete process.env.NEXORA_DEFAULT_STORAGE_QUOTA_BYTES;
  assert.equal(resolveOrganizationQuotaBytes(null), null);
});

test("invalid default values are treated as unset, not as a cap", () => {
  for (const value of ["0", "-5", "1.5", "not-a-number", ""]) {
    process.env.NEXORA_DEFAULT_STORAGE_QUOTA_BYTES = value;
    assert.equal(parseDefaultStorageQuotaBytes(value), null);
    assert.equal(resolveOrganizationQuotaBytes(null), null);
  }
  delete process.env.NEXORA_DEFAULT_STORAGE_QUOTA_BYTES;
});
