import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { aiExtractionConfirmSchema } from "../../../../../../../../../security/ai-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../../../../server/db.ts";
import { lockProjectForWork } from "../../../../../../../../../server/project-work.ts";

export const runtime = "nodejs";

const OPERATION = "extraction.confirm";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// An extracted deadline is text, not a date. Only a real ISO calendar
// date becomes a due_date; anything else ("next Friday", "Q3") stays
// as a suggested-deadline line so no date is invented.
function parseDueDate(deadline: string | null | undefined): string | null {
  if (!deadline || !ISO_DATE_PATTERN.test(deadline)) return null;
  return new Date(deadline).toISOString().slice(0, 10) === deadline ? deadline : null;
}

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string }>;
}

// AI meeting-notes extraction, step 2 of 2 (PRD 19): creates the
// reviewed draft's tasks in an existing project, in ONE transaction.
// The caller must be able to work in the project (viewers are denied,
// as with manual task creation) and the project must not be closed.
// Extracted owners are NAMES from the notes: they are never resolved
// to user ids (names are not unique and guessing assignees would be
// invention), so they are recorded as "Suggested owner" lines in the
// task description. Decisions, follow-ups, and risks are informational
// output of the workflow: they are echoed in the response and shown
// in the UI, but there is no project-level record type for them, so
// they are not persisted as separate rows.
export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, aiExtractionConfirmSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return jsonError(request, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid idempotency key and retry.");
  }
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId } = await params;
    if (!UUID_PATTERN.test(projectId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project identifier is invalid.");
    }
    if (await isRateLimited(request, "project-management-user", principal.userId, 40, 3600, 80)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many project changes. Wait before trying again.", {
        "retry-after": "3600",
      });
    }
    const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    // The project id is part of the request hash: the same key used
    // for a different project must conflict, not replay the first
    // project's response.
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ projectId, draft: parsed.value.draft }))
      .digest("hex");
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        // Serialize concurrent confirms sharing one idempotency key so
        // a retried request replays instead of creating twice.
        const lockScope = `${organizationId.toLowerCase()}:${projectId.toLowerCase()}:${principal.userId}:${OPERATION}:${keyHash}`;
        await transaction.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [lockScope],
        );
        const priorResult = await transaction.query<{
          request_hash: string;
          response_status: number;
          response_body: {
            tasks: { id: string; title: string }[];
            decisions: string[];
            followUps: string[];
            risks: string[];
          };
          expires_at: Date;
        }>(
          `SELECT request_hash, response_status, response_body, expires_at
           FROM nexora.ai_creation_idempotency
           WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3 AND key_hash = $4`,
          [organizationId, principal.userId, OPERATION, keyHash],
        );
        const prior = priorResult.rows[0];
        if (prior && prior.expires_at > new Date()) {
          if (prior.request_hash !== requestHash) return { kind: "idempotency_conflict" as const };
          return { kind: "replayed" as const, body: prior.response_body };
        }
        if (prior) {
          await transaction.query(
            `DELETE FROM nexora.ai_creation_idempotency
             WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3 AND key_hash = $4`,
            [organizationId, principal.userId, OPERATION, keyHash],
          );
        }

        await lockProjectForWork(transaction, organizationId, projectId);
        const access = await transaction.query<{ status: string; can_work: boolean }>(
          `SELECT project.status::text AS status,
                  nexora.can_work_current_project(project.organization_id, project.id) AS can_work
           FROM nexora.projects AS project
           WHERE project.organization_id = $1 AND project.id = $2 AND project.deleted_at IS NULL`,
          [organizationId, projectId],
        );
        if (!access.rows[0]) return { kind: "not_found" as const };
        if (!access.rows[0].can_work) return { kind: "forbidden" as const };
        if (["completed", "archived"].includes(access.rows[0].status)) return { kind: "project_closed" as const };

        const statusResult = await transaction.query<{ id: string }>(
          `SELECT id FROM nexora.project_task_statuses
           WHERE organization_id = $1 AND project_id = $2
           ORDER BY sort_order ASC LIMIT 1`,
          [organizationId, projectId],
        );
        const workflowStatusId = statusResult.rows[0]?.id;
        if (!workflowStatusId) throw new Error("Project workflow statuses were not seeded");
        const positionResult = await transaction.query<{ position: number }>(
          `SELECT COALESCE(pg_catalog.max(position) + 1, 0)::integer AS position
           FROM nexora.tasks
           WHERE organization_id = $1 AND project_id = $2
             AND workflow_status_id = $3 AND archived_at IS NULL`,
          [organizationId, projectId, workflowStatusId],
        );
        let position = positionResult.rows[0]?.position ?? 0;

        const createdTasks: { id: string; title: string }[] = [];
        for (const task of parsed.value.draft.tasks) {
          const dueDate = parseDueDate(task.deadline);
          const descriptionLines: string[] = [];
          if (task.owner) descriptionLines.push(`Suggested owner: ${task.owner}`);
          if (task.deadline && !dueDate) descriptionLines.push(`Suggested deadline: ${task.deadline}`);
          const taskId = randomUUID();
          await transaction.query(
            `INSERT INTO nexora.tasks
               (id, organization_id, project_id, title, description, workflow_status_id,
                priority, due_date, position, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, 'medium', $7, $8, $9)`,
            [
              taskId,
              organizationId,
              projectId,
              task.title,
              descriptionLines.length > 0 ? descriptionLines.join("\n") : null,
              workflowStatusId,
              dueDate,
              position,
              principal.userId,
            ],
          );
          position += 1;
          createdTasks.push({ id: taskId, title: task.title });
          await transaction.query(
            `INSERT INTO nexora.audit_events
               (id, organization_id, actor_user_id, action, target_type, target_id, details)
             VALUES ($1, $2, $3, 'task.created', 'task', $4, $5::jsonb)`,
            [randomUUID(), organizationId, principal.userId, taskId, JSON.stringify({ projectId })],
          );
        }
        const body = {
          tasks: createdTasks,
          decisions: parsed.value.draft.decisions,
          followUps: parsed.value.draft.followUps,
          risks: parsed.value.draft.risks,
        };
        await transaction.query(
          `INSERT INTO nexora.ai_creation_idempotency
             (organization_id, actor_user_id, operation, key_hash, request_hash,
              response_status, response_body)
           VALUES ($1, $2, $3, $4, $5, 201, $6::jsonb)`,
          [organizationId, principal.userId, OPERATION, keyHash, requestHash, JSON.stringify(body)],
        );
        return { kind: "created" as const, body };
      },
    );
    if (!result) return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    if (result.kind === "idempotency_conflict") {
      return jsonError(request, 409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for different extraction details.");
    }
    if (result.kind === "not_found") {
      return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    }
    if (result.kind === "forbidden") {
      return jsonError(request, 403, "PROJECT_ACCESS_DENIED", "You do not have access to work in this project.");
    }
    if (result.kind === "project_closed") {
      return jsonError(request, 409, "PROJECT_CLOSED", "This project is closed and cannot accept new tasks.");
    }
    return jsonOk(request, { ...result.body, aiGenerated: true }, 201);
  } catch (error) {
    return jsonServerFailure(request, "ai.extraction.confirm", error);
  }
}
