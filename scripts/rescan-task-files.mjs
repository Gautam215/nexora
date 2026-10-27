import { Pool } from "pg";
import { readObject } from "../src/server/storage.ts";
import { getMalwareScanner } from "../src/server/malware.ts";

// Rescan task files whose scan_status is 'pending' (uploaded
// while no scanner was configured, or predating scanning) or
// 'quarantined' (infected, or scanned while the scanner was
// unavailable). A clean rescan clears a quarantined file; a
// failed or infected rescan keeps it quarantined. This script
// runs as the migrator role (MIGRATOR_DATABASE_URL), which owns
// the table and is not filtered by row-level security, because a
// rescan is an operator job across all tenants, not a tenant
// request. It never marks a file clean without a scanner result:
// if no scanner is configured, or the scanner is unavailable for
// a file, that file is left unchanged and the script exits 1.
// --dry-run lists pending/quarantined counts without scanning.
const dryRun = process.argv.includes("--dry-run");
const connectionString = process.env.MIGRATOR_DATABASE_URL;
if (!connectionString) throw new Error("MIGRATOR_DATABASE_URL is required");

const pool = new Pool({
  connectionString,
  application_name: "nexora-file-rescan",
  max: 2,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  query_timeout: 17000,
});

try {
  const files = await pool.query(
    `SELECT id, storage_key, byte_size::text AS byte_size, scan_status
     FROM nexora.task_files
     WHERE deleted_at IS NULL AND scan_status IN ('pending', 'quarantined')
     ORDER BY created_at, id`,
  );
  const pending = files.rows.filter((row) => row.scan_status === "pending").length;
  const quarantined = files.rows.filter((row) => row.scan_status === "quarantined").length;
  console.log(JSON.stringify({ pending, quarantined, total: files.rows.length }));
  if (dryRun) process.exit(0);

  const scanner = getMalwareScanner();
  if (!scanner) {
    console.error("No malware scanner is configured (NEXORA_MALWARE_SCANNER); nothing was rescanned.");
    process.exit(1);
  }
  let cleaned = 0;
  let keptQuarantined = 0;
  let failed = 0;
  for (const row of files.rows) {
    let bytes;
    try {
      bytes = await readObject(row.storage_key, Number(row.byte_size));
    } catch {
      failed += 1;
      continue;
    }
    const result = await scanner.scan(bytes);
    if (result.outcome === "clean") {
      await pool.query("UPDATE nexora.task_files SET scan_status = 'clean' WHERE id = $1", [row.id]);
      cleaned += 1;
    } else if (result.outcome === "infected") {
      await pool.query("UPDATE nexora.task_files SET scan_status = 'quarantined' WHERE id = $1", [row.id]);
      keptQuarantined += 1;
    } else {
      // Unavailable: leave the row exactly as it was. Marking
      // it quarantined would be harmless, but a rescan that
      // cannot reach the scanner must not rewrite state it
      // did not verify; the operator reruns it once the scanner
      // is back.
      failed += 1;
    }
  }
  console.log(JSON.stringify({ cleaned, keptQuarantined, failed }));
  if (failed > 0) process.exit(1);
} finally {
  await pool.end();
}
