import "server-only";

// Organization storage quota resolution.
//
// Precedence, in order:
//   1. An explicit per-organization quota (organizations.storage_quota_bytes)
//      always wins, including an explicit value set by an owner/admin.
//   2. NEXORA_DEFAULT_STORAGE_QUOTA_BYTES, when set to a positive
//      integer, applies only to organizations with no explicit quota.
//   3. Otherwise there is no cap (NULL), exactly as before this change.
//
// The default is deliberately opt-in, not a hidden cap: with the
// variable unset, behaviour is unchanged. An invalid (non-positive,
// non-integer) value is treated as unset rather than failing uploads,
// because a misconfigured default must not break file uploads; the
// operator should still fix it, and the documented recommended value
// is 1073741824 (1 GiB). See docs/deployment.md.
export function parseDefaultStorageQuotaBytes(
  value: string | undefined,
): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function resolveOrganizationQuotaBytes(
  organizationQuotaBytes: string | null,
): number | null {
  if (organizationQuotaBytes !== null && organizationQuotaBytes !== undefined) {
    const parsed = Number(organizationQuotaBytes);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    return null;
  }
  return parseDefaultStorageQuotaBytes(process.env.NEXORA_DEFAULT_STORAGE_QUOTA_BYTES);
}
