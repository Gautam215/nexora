import { createHash } from "node:crypto";

export function isMigrationName(name) {
  return /^\d{4}_[a-z0-9_]+\.sql$/.test(name);
}

export function migrationChecksum(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
