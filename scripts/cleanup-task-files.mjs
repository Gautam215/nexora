import { Pool } from "pg";
import {
  listStalePrivateFileKeys,
  removePrivateFile,
} from "../src/server/private-file-storage.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must use the restricted Nexora runtime role");

const pool = new Pool({
  connectionString,
  application_name: "nexora-file-retention",
  max: 2,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  query_timeout: 17000,
});

try {
  const expired = await pool.query("SELECT storage_key FROM nexora.purge_expired_task_files()");
  let purged = 0;
  for (const row of expired.rows) {
    await removePrivateFile(row.storage_key);
    purged += 1;
  }

  const orphanCandidates = await listStalePrivateFileKeys(new Date(Date.now() - 24 * 60 * 60 * 1000));
  let orphans = 0;
  for (let offset = 0; offset < orphanCandidates.length; offset += 1000) {
    const batch = orphanCandidates.slice(offset, offset + 1000);
    const unreferenced = await pool.query(
      "SELECT storage_key FROM nexora.list_unreferenced_task_file_keys($1::uuid[])",
      [batch],
    );
    for (const row of unreferenced.rows) {
      await removePrivateFile(row.storage_key);
      orphans += 1;
    }
  }

  console.log(`Private file cleanup removed ${purged} expired files and ${orphans} orphaned objects.`);
} finally {
  await pool.end();
}
