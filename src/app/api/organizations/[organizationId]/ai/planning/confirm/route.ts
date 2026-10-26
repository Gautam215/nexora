import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { aiPlanningConfirmSchema } from "../../../../../../../security/ai-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../../server/db.ts";
import { lockProjectTaskGraph } from "../../../../../../../server/project-work.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const OPERATION = "planning.confirm";

type ConfirmResult =
  | { kind: "created"; projectId: string; projectName: string; milestoneCount: number; taskCount: number }
  | { kind: "replayed"; projectId: string; projectName: string; milestoneCount: number; taskCount: number }
  | { kind: "idempotency_conflict" }
  | { kind: "dependency_unknown"; title: string }
  | { kind: "dependency_ambiguous"; title: string }
  | { kind: "dependency_cycle" };

// AI project planning, step 2: confirm (PRD 18). Only this endpoint
// creates anything, and only after the user reviewed the draft and
// named the project. Everything happens in ONE transaction: project,
// creator-as-manager membership, milestones, tasks, subtasks,
// dependencies, and audit events — so a failed dependency check rolls
// back the whole plan instead of leaving a partial project behind.
//
// Dependency contract (documented in API.md): dependency endpoints
// reference task titles and must each match EXACTLY ONE task title
// in the plan. Zero matches is unknown, more than one is ambiguous,
// and a cycle is rejected — all before any row is committed.
// Provider output cannot invent assignees or dates, so created tasks
// are unassigned, in the seeded Backlog status, with sequential
// positions.
//
// Idempotency mirrors the milestone route, but at the organization
// level (migration 0035): the project does not exist yet, so the
// project-scoped idempotency table cannot key this confirmation.
export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "FORBIDDEN_ORIGIN", "Request origin is not allowed.");
  }
  const parsed = await parseJson(request, aiPlanningConfirmSchema);
  if (!parsed.ok) {
    return jsonError(request, parsed.status, parsed.code, parsed.message);
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return jsonError(request, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid idempotency key and retry.");
  }
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId } = await params;
    if (await isRateLimited(request, "project-management-user", principal.userId, 40, 3600, 80)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many project changes. Wait before trying again.", {
        "retry-after": "3600",
      });
    }
    const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    const requestHash = createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex");
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const priorResult = await transaction.query<{
          request_hash: string;
          response_status: number;
          response_body: { project: { id: string; name: string }; milestoneCount: number; taskCount: number };
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
          return {
            kind: "replayed" as const,
            projectId: prior.response_body.project.id,
            projectName: prior.response_body.project.name,
            milestoneCount: prior.response_body.milestoneCount,
            taskCount: prior.response_body.taskCount,
          };
        }
        if (prior) {
          await transaction.query(
            `DELETE FROM nexora.ai_creation_idempotency
             WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3 AND key_hash = $4`,
            [organizationId, principal.userId, OPERATION, keyHash],
          );
        }

        // Dependency validation happens BEFORE any insert. Early
        // returns inside this transaction callback would otherwise
        // commit the rows already written, leaving a partial plan
        // behind — so endpoints and cycles are checked against the
        // draft's titles alone, and insertion only starts once the
        // whole plan is known to be valid.
        const titleCounts = new Map<string, number>();
        const countTitle = (title: string) => {
          titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
        };
        for (const milestone of parsed.value.draft.milestones) {
          for (const task of milestone.tasks) {
            countTitle(task.title);
            for (const subtaskTitle of task.subtasks ?? []) countTitle(subtaskTitle);
          }
        }
        const titleEdges: { from: string; to: string }[] = [];
        for (const dependency of parsed.value.draft.dependencies ?? []) {
          if ((titleCounts.get(dependency.from) ?? 0) === 0) {
            return { kind: "dependency_unknown" as const, title: dependency.from };
          }
          if ((titleCounts.get(dependency.to) ?? 0) === 0) {
            return { kind: "dependency_unknown" as const, title: dependency.to };
          }
          if ((titleCounts.get(dependency.from) ?? 0) > 1) {
            return { kind: "dependency_ambiguous" as const, title: dependency.from };
          }
          if ((titleCounts.get(dependency.to) ?? 0) > 1) {
            return { kind: "dependency_ambiguous" as const, title: dependency.to };
          }
          titleEdges.push({ from: dependency.from, to: dependency.to });
        }
        // Cycle check on the title graph: "from finishes before to
        // starts" is an edge from -> to; a cycle exists if any title
        // reaches itself.
        const outgoing = new Map<string, string[]>();
        for (const edge of titleEdges) {
          const list = outgoing.get(edge.from) ?? [];
          list.push(edge.to);
          outgoing.set(edge.from, list);
        }
        const hasCycle = (() => {
          const visiting = new Set<string>();
          const visited = new Set<string>();
          const visit = (title: string): boolean => {
            if (visiting.has(title)) return true;
            if (visited.has(title)) return false;
            visiting.add(title);
            for (const next of outgoing.get(title) ?? []) {
              if (visit(next)) return true;
            }
            visiting.delete(title);
            visited.add(title);
            return false;
          };
          for (const title of outgoing.keys()) {
            if (visit(title)) return true;
          }
          return false;
        })();
        if (hasCycle) return { kind: "dependency_cycle" as const };

        const projectId = randomUUID();
        await transaction.query(
          `INSERT INTO nexora.projects
             (id, organization_id, name, owner_user_id)
           VALUES ($1, $2, $3, $4)`,
          [projectId, organizationId, parsed.value.projectName, principal.userId],
        );
        await transaction.query(
          `INSERT INTO nexora.project_memberships
             (organization_id, project_id, user_id, role, status, added_by_user_id)
           VALUES ($1, $2, $3, 'manager', 'active', $3)`,
          [organizationId, projectId, principal.userId],
        );
        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'project.created', 'project', $4, $5::jsonb)`,
          [randomUUID(), organizationId, principal.userId, projectId, JSON.stringify({ status: "planned" })],
        );
        await lockProjectTaskGraph(transaction, organizationId, projectId);
        const statusResult = await transaction.query<{ id: string }>(
          `SELECT id FROM nexora.project_task_statuses
           WHERE organization_id = $1 AND project_id = $2
           ORDER BY sort_order ASC LIMIT 1`,
          [organizationId, projectId],
        );
        const backlogStatusId = statusResult.rows[0]?.id;
        if (!backlogStatusId) throw new Error("Project workflow statuses were not seeded");

        let position = 0;
        let taskCount = 0;
        const titleToIds = new Map<string, string[]>();
        const registerTitle = (title: string, id: string) => {
          const ids = titleToIds.get(title) ?? [];
          ids.push(id);
          titleToIds.set(title, ids);
        };
        for (const milestone of parsed.value.draft.milestones) {
          const milestoneId = randomUUID();
          await transaction.query(
            `INSERT INTO nexora.milestones
               (id, organization_id, project_id, name, description, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [milestoneId, organizationId, projectId, milestone.name, milestone.description ?? null, principal.userId],
          );
          await transaction.query(
            `INSERT INTO nexora.audit_events
               (id, organization_id, actor_user_id, action, target_type, target_id, details)
             VALUES ($1, $2, $3, 'milestone.created', 'milestone', $4, $5::jsonb)`,
            [randomUUID(), organizationId, principal.userId, milestoneId, JSON.stringify({ projectId })],
          );
          for (const task of milestone.tasks) {
            const taskId = randomUUID();
            await transaction.query(
              `INSERT INTO nexora.tasks
                 (id, organization_id, project_id, title, description, workflow_status_id,
                  priority, milestone_id, position, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6, 'medium', $7, $8, $9)`,
              [
                taskId,
                organizationId,
                projectId,
                task.title,
                task.description ?? null,
                backlogStatusId,
                milestoneId,
                position,
                principal.userId,
              ],
            );
            position += 1;
            taskCount += 1;
            registerTitle(task.title, taskId);
            await transaction.query(
              `INSERT INTO nexora.audit_events
                 (id, organization_id, actor_user_id, action, target_type, target_id, details)
               VALUES ($1, $2, $3, 'task.created', 'task', $4, $5::jsonb)`,
              [randomUUID(), organizationId, principal.userId, taskId, JSON.stringify({ projectId })],
            );
            for (const subtaskTitle of task.subtasks ?? []) {
              const subtaskId = randomUUID();
              await transaction.query(
                `INSERT INTO nexora.tasks
                   (id, organization_id, project_id, title, workflow_status_id,
                    priority, milestone_id, parent_task_id, position, created_by_user_id)
                 VALUES ($1, $2, $3, $4, $5, 'medium', $6, $7, $8, $9)`,
                [
                  subtaskId,
                  organizationId,
                  projectId,
                  subtaskTitle,
                  backlogStatusId,
                  milestoneId,
                  taskId,
                  position,
                  principal.userId,
                ],
              );
              position += 1;
              taskCount += 1;
              registerTitle(subtaskTitle, subtaskId);
              await transaction.query(
                `INSERT INTO nexora.audit_events
                   (id, organization_id, actor_user_id, action, target_type, target_id, details)
                 VALUES ($1, $2, $3, 'task.created', 'task', $4, $5::jsonb)`,
                [randomUUID(), organizationId, principal.userId, subtaskId, JSON.stringify({ projectId })],
              );
            }
          }
        }

        // Titles are unique at this point (ambiguity was rejected
        // above), so each title maps to exactly one created task id.
        // "from must finish before to starts": the TO task depends on
        // the FROM task.
        for (const edge of titleEdges) {
          const taskId = titleToIds.get(edge.to)?.[0];
          const dependsOnTaskId = titleToIds.get(edge.from)?.[0];
          if (!taskId || !dependsOnTaskId) throw new Error("Planning title map is incomplete");
          await transaction.query(
            `INSERT INTO nexora.task_dependencies
               (organization_id, project_id, task_id, depends_on_task_id)
             VALUES ($1, $2, $3, $4)`,
            [organizationId, projectId, taskId, dependsOnTaskId],
          );
        }

        const responseBody = {
          project: { id: projectId, name: parsed.value.projectName },
          milestoneCount: parsed.value.draft.milestones.length,
          taskCount,
        };
        await transaction.query(
          `INSERT INTO nexora.ai_creation_idempotency
             (organization_id, actor_user_id, operation, key_hash, request_hash, response_status, response_body)
           VALUES ($1, $2, $3, $4, $5, 201, $6::jsonb)`,
          [organizationId, principal.userId, OPERATION, keyHash, requestHash, JSON.stringify(responseBody)],
        );
        return { kind: "created" as const, projectId, projectName: parsed.value.projectName, milestoneCount: responseBody.milestoneCount, taskCount };
      },
    );
    const resultTyped = result as ConfirmResult;
    if (resultTyped.kind === "idempotency_conflict") {
      return jsonError(request, 409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for different plan details.");
    }
    if (resultTyped.kind === "dependency_unknown") {
      return jsonError(request, 400, "PLANNING_DEPENDENCY_UNKNOWN", `Dependency references an unknown task: ${resultTyped.title}.`);
    }
    if (resultTyped.kind === "dependency_ambiguous") {
      return jsonError(
        request,
        400,
        "PLANNING_DEPENDENCY_AMBIGUOUS",
        `Dependency task title matches more than one task: ${resultTyped.title}. Rename tasks so titles are unique and retry.`,
      );
    }
    if (resultTyped.kind === "dependency_cycle") {
      return jsonError(request, 409, "TASK_DEPENDENCY_CYCLE", "Task dependencies cannot form a cycle.");
    }
    return jsonOk(
      request,
      {
        project: { id: resultTyped.projectId, name: resultTyped.projectName },
        milestoneCount: resultTyped.milestoneCount,
        taskCount: resultTyped.taskCount,
      },
      201,
    );
  } catch (error) {
    return jsonServerFailure(request, "ai.planning.confirm", error);
  }
}
