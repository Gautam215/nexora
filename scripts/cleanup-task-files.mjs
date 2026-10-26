import { Pool } from "pg";
import {
  listStalePrivateFileKeys,
  removePrivateFile,
} from "../src/server/private-file-storage.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must use the restricted Nexora runtime role");

// --dry-run reports what would be purged without deleting any database
// record or file. It only runs SELECT queries and read-only functions;
// it never calls a purge function and never removes a file.
const dryRun = process.argv.includes("--dry-run");

const pool = new Pool({
  connectionString,
  application_name: "nexora-file-retention",
  max: 2,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  query_timeout: 17000,
});

try {
  // Expired-project listing runs through a SECURITY DEFINER function: the
  // command runs as the runtime role without a tenant session, so a plain
  // SELECT on nexora.projects or nexora.task_files would return nothing
  // under row-level security. The listing itself deletes nothing.
  const expiredProjects = await pool.query(
    "SELECT project_id, project_name, storage_key FROM nexora.list_expired_projects()",
  );
  const expiredProjectIds = [...new Set(expiredProjects.rows.map((row) => row.project_id))];
  const expiredProjectNames = new Map(
    expiredProjects.rows.map((row) => [row.project_id, row.project_name]),
  );
  const expiredProjectKeys = expiredProjects.rows
    .map((row) => row.storage_key)
    .filter((key) => key !== null);
  // Expired milestones use the same SECURITY DEFINER listing rationale
  // as expired projects. Their purge detaches tasks instead of deleting
  // them, so the dry run reports the tasks that would be detached.
  const expiredMilestones = await pool.query(
    "SELECT milestone_id, milestone_name, task_count FROM nexora.list_expired_milestones()",
  );
  // Expired organizations, same rationale. Their purge removes every
  // operational child row but leaves the organization tombstone and its
  // audit trail (see migration 0033), so the dry run reports the
  // projects and files that would go, not the organization row itself.
  const expiredOrganizations = await pool.query(
    "SELECT organization_id, organization_name, project_count, file_count FROM nexora.list_expired_organizations()",
  );
  const expiredOrganizationProjects = expiredOrganizations.rows.reduce(
    (total, row) => total + Number(row.project_count),
    0,
  );
  const expiredOrganizationFiles = expiredOrganizations.rows.reduce(
    (total, row) => total + Number(row.file_count),
    0,
  );
  const expiredMilestoneTasks = expiredMilestones.rows.reduce(
    (total, row) => total + row.task_count,
    0,
  );

  if (dryRun) {
    const expiredFiles = await pool.query("SELECT storage_key FROM nexora.list_expired_task_files()");
    const orphanCandidates = await listStalePrivateFileKeys(new Date(Date.now() - 24 * 60 * 60 * 1000));
    let orphanCount = 0;
    for (let offset = 0; offset < orphanCandidates.length; offset += 1000) {
      const batch = orphanCandidates.slice(offset, offset + 1000);
      const unreferenced = await pool.query(
        "SELECT storage_key FROM nexora.list_unreferenced_task_file_keys($1::uuid[])",
        [batch],
      );
      orphanCount += unreferenced.rows.length;
    }
    console.log(
      `Dry run: would purge ${expiredOrganizations.rows.length} expired organization(s) (${expiredOrganizationProjects} project(s), ${expiredOrganizationFiles} file object(s)), ` +
        `${expiredProjectIds.length} expired project(s) and ${expiredProjectKeys.length} project file object(s), ` +
        `${expiredMilestones.rows.length} expired milestone(s) and detach ${expiredMilestoneTasks} task(s), ` +
        `${expiredFiles.rows.length} expired task file(s), and ${orphanCount} orphaned object(s). ` +
        "No database records or files were deleted.",
    );
    for (const row of expiredOrganizations.rows) {
      console.log(`Would purge organization ${row.organization_id} (${row.organization_name}).`);
    }
    for (const projectId of expiredProjectIds) {
      console.log(`Would purge project ${projectId} (${expiredProjectNames.get(projectId) ?? "unnamed"}).`);
    }
    for (const row of expiredMilestones.rows) {
      console.log(`Would purge milestone ${row.milestone_id} (${row.milestone_name}).`);
    }
  } else {
    // Expired organizations first: the database purge commits before
    // any file is removed from disk, so a disk failure leaves orphan
    // keys for the 24-hour scan instead of rows pointing at missing
    // files. An organization purge removes whole organizations
    // including their projects, so it runs before the project purge;
    // the project count below is the pre-purge listing count and may
    // therefore include projects this step already removed, exactly
    // like the concurrent-run caveat. A skipped organization (the
    // purge function warns and skips one it cannot purge) stays
    // expired and is retried next run, so a shortfall is warned
    // about instead of silently passing.
    const purgedOrganizations = await pool.query(
      "SELECT organization_id, storage_key FROM nexora.purge_expired_organizations()",
    );
    const purgedOrganizationIds = [...new Set(purgedOrganizations.rows.map((row) => row.organization_id))];
    let purgedOrganizationFiles = 0;
    for (const row of purgedOrganizations.rows) {
      if (row.storage_key === null) continue;
      await removePrivateFile(row.storage_key);
      purgedOrganizationFiles += 1;
    }
    console.log(
      `Organization cleanup removed ${purgedOrganizationIds.length} expired organization(s) and ${purgedOrganizationFiles} file object(s).`,
    );
    if (purgedOrganizationIds.length < expiredOrganizations.rows.length) {
      console.warn(
        `Organization cleanup skipped ${expiredOrganizations.rows.length - purgedOrganizationIds.length} expired organization(s); see database logs for details.`,
      );
    }

    // Expired projects next: the database purge commits before any file is
    // removed from disk, so a disk failure leaves orphan keys for the
    // 24-hour scan instead of rows pointing at missing files. The project
    // count below is the pre-purge listing count; a concurrent cleanup run
    // could purge some of the same projects first, in which case the
    // purge function returns fewer file keys and only those are removed.
    const purgedKeys = await pool.query("SELECT storage_key FROM nexora.purge_expired_projects()");
    let purgedProjectFiles = 0;
    for (const row of purgedKeys.rows) {
      await removePrivateFile(row.storage_key);
      purgedProjectFiles += 1;
    }
    console.log(
      `Project cleanup removed ${expiredProjectIds.length} expired project(s) and ${purgedProjectFiles} file object(s).`,
    );

    // Expired milestones next: project purge already removed whole
    // projects, so this only touches milestones in surviving projects.
    // The purge detaches tasks (it never deletes them) and returns one
    // row per purged milestone, so these counts are exact for this run.
    // A milestone the purge had to skip (e.g. its project was archived
    // after deletion, so the task guard refuses the detach) stays expired
    // and is retried next run; a shortfall against the listing is
    // therefore warned about instead of silently passing.
    const purgedMilestones = await pool.query(
      "SELECT milestone_id, detached_task_count FROM nexora.purge_expired_milestones()",
    );
    const detachedTasks = purgedMilestones.rows.reduce(
      (total, row) => total + row.detached_task_count,
      0,
    );
    console.log(
      `Milestone cleanup removed ${purgedMilestones.rows.length} expired milestone(s) and detached ${detachedTasks} task(s).`,
    );
    if (purgedMilestones.rows.length < expiredMilestones.rows.length) {
      console.warn(
        `Milestone cleanup skipped ${expiredMilestones.rows.length - purgedMilestones.rows.length} expired milestone(s); see database logs for details.`,
      );
    }

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
  }
} finally {
  await pool.end();
}
