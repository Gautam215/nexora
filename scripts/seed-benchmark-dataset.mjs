import { randomUUID } from "node:crypto";
import { Pool } from "pg";

// Realistic synthetic dataset for the local query benchmark
// (scripts/benchmark-queries.mjs). Run ONLY against a disposable
// database with the migrator role, never production: it inserts
// 200 organizations, 500 projects, 5000 tasks, 2000 task files,
// and 5000 notifications — a plausible early-production workload,
// sized so the benchmark numbers mean more than the old
// empty-dataset baseline. Every run uses fresh organization
// slugs, so reruns accumulate rows; for comparable numbers,
// seed a freshly migrated database. The two benchmark users
// have fixed ids and are inserted ON CONFLICT DO NOTHING.
// Tenant context is set per organization transaction, the same
// way withOrganizationContext sets it for app requests.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const ORG_COUNT = Number(process.env.NEXORA_BENCH_ORGS ?? 200);
const PROJECT_COUNT = Number(process.env.NEXORA_BENCH_PROJECTS ?? 500);
const TASK_COUNT = Number(process.env.NEXORA_BENCH_TASKS ?? 5000);
const FILE_COUNT = Number(process.env.NEXORA_BENCH_FILES ?? 2000);
const NOTIFICATION_COUNT = Number(process.env.NEXORA_BENCH_NOTIFICATIONS ?? 5000);

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

const pool = new Pool({
  connectionString,
  application_name: "nexora-benchmark-seed",
  max: 5,
  connectionTimeoutMillis: 5000,
  statement_timeout: 60000,
  query_timeout: 62000,
});

function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function insertMany(client, sql, rows) {
  for (const batch of chunk(rows, 500)) {
    const values = [];
    const params = [];
    batch.forEach((row, rowIndex) => {
      const placeholders = row.map((_, columnIndex) => {
        params.push(row[columnIndex]);
        return `$${params.length}`;
      });
      values.push(`(${placeholders.join(", ")})`);
    });
    await client.query(`${sql} VALUES ${values.join(", ")}`, params);
  }
}

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO nexora.users (id, email, display_name, password_hash, email_verified_at)
       VALUES ($1, 'bench-owner@example.test', 'Benchmark Owner', NULL, pg_catalog.now()),
              ($2, 'bench-member@example.test', 'Benchmark Member', NULL, pg_catalog.now())
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_ID, MEMBER_ID],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.error("seed: users done");

  console.error("seed: starting organizations");
  const orgIds = [];
  const projectRows = [];
  for (let i = 0; i < ORG_COUNT; i += 1) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    const client2 = await pool.connect();
    try {
      await client2.query("BEGIN");
      await client2.query("SELECT pg_catalog.set_config('nexora.user_id', $1, true)", [OWNER_ID]);
      await client2.query("SELECT pg_catalog.set_config('nexora.organization_id', $1, true)", [orgId]);
      await client2.query(
        `INSERT INTO nexora.organizations (id, name, slug, created_by)
         VALUES ($1, $2, $3, $4)`,
        [orgId, `Benchmark org ${i}`, `bench-${randomUUID().slice(0, 8)}`, OWNER_ID],
      );
      await client2.query(
        `INSERT INTO nexora.organization_memberships
           (organization_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'owner', 'active', pg_catalog.now()),
                ($1, $3, 'member', 'active', pg_catalog.now())`,
        [orgId, OWNER_ID, MEMBER_ID],
      );
      await client2.query("COMMIT");
    } catch (error) {
      await client2.query("ROLLBACK");
      throw error;
    } finally {
      client2.release();
    }
  }

  console.error("seed: organizations done");
  for (let p = 0; p < PROJECT_COUNT; p += 1) {
    projectRows.push({
      id: randomUUID(),
      organizationId: orgIds[p % ORG_COUNT],
      name: `Benchmark project ${p}`,
    });
  }
  console.error("seed: starting projects");
  {
    const client3 = await pool.connect();
    try {
      await client3.query("BEGIN");
      await client3.query("SELECT pg_catalog.set_config('nexora.user_id', $1, true)", [OWNER_ID]);
      for (const project of projectRows) {
        await client3.query("SELECT pg_catalog.set_config('nexora.organization_id', $1, true)", [
          project.organizationId,
        ]);
        await client3.query(
          `INSERT INTO nexora.projects (id, organization_id, name, owner_user_id)
           VALUES ($1, $2, $3, $4)`,
          [project.id, project.organizationId, project.name, OWNER_ID],
        );
        // No status insert here: the projects_seed_task_workflow
        // trigger seeds Backlog / To do / In progress / In review
        // / Done on project insert; inserting them again violates
        // the per-project name unique index.
        await client3.query(
          `INSERT INTO nexora.project_memberships
             (organization_id, project_id, user_id, role, status, added_by_user_id)
           VALUES ($1, $2, $3, 'manager', 'active', $3),
                  ($1, $2, $4, 'member', 'active', $3)`,
          [project.organizationId, project.id, OWNER_ID, MEMBER_ID],
        );
      }
      await client3.query("COMMIT");
      console.error("seed: projects done");
    } catch (error) {
      await client3.query("ROLLBACK");
      throw error;
    } finally {
      client3.release();
    }
  }

  // Status ids per project, in Todo/Doing/Done order.
  const statusQuery = await pool.query(
    `SELECT organization_id, project_id, id, is_done
     FROM nexora.project_task_statuses
     ORDER BY project_id, sort_order`,
  );
  const statusesByProject = new Map();
  for (const row of statusQuery.rows) {
    const list = statusesByProject.get(row.project_id) ?? [];
    list.push(row.id);
    statusesByProject.set(row.project_id, list);
  }

  const taskRows = [];
  for (let t = 0; t < TASK_COUNT; t += 1) {
    const project = projectRows[t % PROJECT_COUNT];
    const statuses = statusesByProject.get(project.id) ?? [];
    taskRows.push({
      id: randomUUID(),
      organizationId: project.organizationId,
      projectId: project.id,
      title: `Benchmark task ${t}`,
      statusId: statuses[t % statuses.length] ?? statuses[0],
    });
  }
  {
    const client4 = await pool.connect();
    try {
      await client4.query("BEGIN");
      await client4.query("SELECT pg_catalog.set_config('nexora.user_id', $1, true)", [OWNER_ID]);
      for (const orgId of orgIds) {
        const rows = taskRows.filter((task) => task.organizationId === orgId);
        if (rows.length === 0) continue;
        await client4.query("SELECT pg_catalog.set_config('nexora.organization_id', $1, true)", [orgId]);
        await insertMany(
          client4,
          `INSERT INTO nexora.tasks
             (id, organization_id, project_id, title, workflow_status_id, created_by_user_id)`,
          rows.map((task) => [
            task.id,
            task.organizationId,
            task.projectId,
            task.title,
            task.statusId,
            OWNER_ID,
          ]),
        );
      }
      await client4.query("COMMIT");
    } catch (error) {
      await client4.query("ROLLBACK");
      throw error;
    } finally {
      client4.release();
    }
  }

  const fileRows = [];
  for (let f = 0; f < FILE_COUNT; f += 1) {
    const task = taskRows[f % TASK_COUNT];
    fileRows.push({
      id: randomUUID(),
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      filename: f % 2 === 0 ? `release-notes-${f}.txt` : `spec-${f}.pdf`,
      byteSize: 1000 + ((f * 37) % 90000),
      sha: String(f).padStart(64, "0"),
      storageKey: randomUUID(),
    });
  }
  {
    const client5 = await pool.connect();
    try {
      await client5.query("BEGIN");
      await client5.query("SELECT pg_catalog.set_config('nexora.user_id', $1, true)", [OWNER_ID]);
      for (const orgId of orgIds) {
        const rows = fileRows.filter((file) => file.organizationId === orgId);
        if (rows.length === 0) continue;
        await client5.query("SELECT pg_catalog.set_config('nexora.organization_id', $1, true)", [orgId]);
        await insertMany(
          client5,
          `INSERT INTO nexora.task_files
             (id, organization_id, project_id, task_id, original_filename, mime_type,
              byte_size, sha256, storage_key, uploaded_by_user_id, scan_status)`,
          rows.map((file) => [
            file.id,
            file.organizationId,
            file.projectId,
            file.taskId,
            file.filename,
            "text/plain",
            file.byteSize,
            file.sha,
            file.storageKey,
            OWNER_ID,
            "clean",
          ]),
        );
      }
      await client5.query("COMMIT");
    } catch (error) {
      await client5.query("ROLLBACK");
      throw error;
    } finally {
      client5.release();
    }
  }

  const notificationRows = [];
  for (let n = 0; n < NOTIFICATION_COUNT; n += 1) {
    const task = taskRows[n % TASK_COUNT];
    notificationRows.push({
      id: randomUUID(),
      organizationId: task.organizationId,
      projectId: task.projectId,
      targetId: task.id,
      dedupe: `bench-notif-${n}-${randomUUID().slice(0, 8)}`,
    });
  }
  {
    const client6 = await pool.connect();
    try {
      await client6.query("BEGIN");
      await client6.query("SELECT pg_catalog.set_config('nexora.user_id', $1, true)", [OWNER_ID]);
      for (const orgId of orgIds) {
        const rows = notificationRows.filter((notification) => notification.organizationId === orgId);
        if (rows.length === 0) continue;
        await client6.query("SELECT pg_catalog.set_config('nexora.organization_id', $1, true)", [orgId]);
        await insertMany(
          client6,
          `INSERT INTO nexora.notifications
             (id, organization_id, project_id, recipient_user_id, actor_user_id,
              event_type, target_type, target_id, dedupe_key, title, body, href)`,
          rows.map((notification, index) => [
            notification.id,
            notification.organizationId,
            notification.projectId,
            MEMBER_ID,
            OWNER_ID,
            "project_activity",
            "task",
            notification.targetId,
            notification.dedupe,
            `Benchmark notification ${index}`,
            "Benchmark notification body",
            `/organizations/${notification.organizationId}/projects/${notification.projectId}/tasks`,
          ]),
        );
      }
      await client6.query("COMMIT");
    } catch (error) {
      await client6.query("ROLLBACK");
      throw error;
    } finally {
      client6.release();
    }
  }

  const counts = await pool.query(
    `SELECT (SELECT count(*) FROM nexora.organizations) AS organizations,
            (SELECT count(*) FROM nexora.projects) AS projects,
            (SELECT count(*) FROM nexora.tasks) AS tasks,
            (SELECT count(*) FROM nexora.task_files) AS task_files,
            (SELECT count(*) FROM nexora.notifications) AS notifications`,
  );
  console.log(JSON.stringify({ seeded: { organizations: ORG_COUNT, projects: PROJECT_COUNT, tasks: TASK_COUNT, task_files: FILE_COUNT, notifications: NOTIFICATION_COUNT }, totals: counts.rows[0] }));
} finally {
  await pool.end();
}
