-- Per-organization storage quota (approved default, 2026-10-26).
-- NULL means no organization quota: the per-task caps (20 files,
-- 100 MB per task) still apply. No production quota value is
-- invented here; the value is an explicit configuration set by a
-- workspace owner or admin through PATCH /api/organizations/{id}
-- (or left NULL by a product decision). The CHECK only guards
-- against nonsense values (zero, negative); the API schema caps
-- the value at 1 TiB. Grants are column-level on this table, so
-- the new column is granted in this migration and mirrored in
-- db/runtime-grants.sql, which the migrator reapplies every run.
ALTER TABLE nexora.organizations
  ADD COLUMN storage_quota_bytes bigint
    CONSTRAINT organizations_storage_quota_check
      CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes > 0);

GRANT SELECT (storage_quota_bytes), UPDATE (storage_quota_bytes)
ON TABLE nexora.organizations TO nexora_app;
