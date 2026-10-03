import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { taskCommentCreateSchema } from "../../../../../../../../../security/task-schemas.ts";
import { hasSameOrigin, jsonError, jsonOk, jsonServerFailure, parseJson } from "../../../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../../../../server/db.ts";
import { notifyProjectMember, notifyProjectMembers } from "../../../../../../../../../server/project-notifications.ts";
import { lockProjectForWork, lockProjectTaskGraph } from "../../../../../../../../../server/project-work.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string; taskId: string }>;
}

interface TaskComment {
  id: string;
  body: string;
  created_at: Date;
  author_name: string | null;
  mentions: Array<{ user_id: string; display_name: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MENTION_TOKEN_PATTERN = /@\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId, taskId } = await params;
    if (![projectId, taskId].every((value) => UUID_PATTERN.test(value))) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project or task identifier is invalid.");
    }

    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const project = await transaction.query<{ can_access: boolean }>(
          `SELECT nexora.can_access_current_project(project.organization_id, project.id) AS can_access
           FROM nexora.projects AS project
           WHERE project.organization_id = $1 AND project.id = $2`,
          [organizationId, projectId],
        );
        if (!project.rows[0]?.can_access) return null;

        const task = await transaction.query(
          `SELECT id FROM nexora.tasks
           WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
          [organizationId, projectId, taskId],
        );
        if (!task.rowCount) return null;

        const rows = await transaction.query<TaskComment>(
          `SELECT recent.id,
                  recent.body,
                  recent.created_at,
                  author.display_name AS author_name,
                  mention_list.mentions
           FROM (
             SELECT comment.id, comment.body, comment.created_at, comment.author_user_id
             FROM nexora.task_comments AS comment
             WHERE comment.organization_id = $1
               AND comment.project_id = $2
               AND comment.task_id = $3
             ORDER BY comment.created_at DESC, comment.id DESC
             LIMIT 101
           ) AS recent
           LEFT JOIN LATERAL (
             SELECT member.display_name
             FROM nexora.list_current_project_members($1, $2) AS member
             WHERE member.user_id = recent.author_user_id
             LIMIT 1
           ) AS author ON true
           LEFT JOIN LATERAL (
             SELECT COALESCE(
                      pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                          'user_id', mention.mentioned_user_id,
                          'display_name', COALESCE(member.display_name, 'Former project member')
                        ) ORDER BY mention.mentioned_user_id
                      ),
                      '[]'::jsonb
                    ) AS mentions
             FROM nexora.task_comment_mentions AS mention
             LEFT JOIN LATERAL (
               SELECT project_member.display_name
               FROM nexora.list_current_project_members($1, $2) AS project_member
               WHERE project_member.user_id = mention.mentioned_user_id
                 AND project_member.status = 'active'
               LIMIT 1
             ) AS member ON true
             WHERE mention.organization_id = $1
               AND mention.project_id = $2
               AND mention.task_id = $3
               AND mention.comment_id = recent.id
           ) AS mention_list ON true
           ORDER BY recent.created_at ASC, recent.id ASC`,
          [organizationId, projectId, taskId],
        );
        return { comments: rows.rows.slice(-100), hasMore: rows.rows.length > 100 };
      },
      "guest",
    );

    if (!result) return jsonError(request, 404, "TASK_NOT_FOUND", "Task not found.");
    return jsonOk(request, result);
  } catch (error) {
    return jsonServerFailure(request, "task-comments.list", error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, taskCommentCreateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return jsonError(request, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid idempotency key and retry.");
  }

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId, taskId } = await params;
    if (![projectId, taskId].every((value) => UUID_PATTERN.test(value))) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project or task identifier is invalid.");
    }
    if (await isRateLimited(request, "project-management-user", principal.userId, 40, 3600, 80)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many project changes. Wait before trying again.", { "retry-after": "3600" });
    }

    const commentId = randomUUID();
    const auditId = randomUUID();
    const operation = "comment.create";
    const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    const requestHash = createHash("sha256").update(JSON.stringify({ taskId: taskId.toLowerCase(), ...parsed.value })).digest("hex");
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        await lockProjectForWork(transaction, organizationId, projectId);
        const project = await transaction.query<{ status: string; can_work: boolean }>(
          `SELECT project.status::text AS status,
                  nexora.can_work_current_project(project.organization_id, project.id) AS can_work
           FROM nexora.projects AS project
           WHERE project.organization_id = $1 AND project.id = $2`,
          [organizationId, projectId],
        );
        if (!project.rows[0]) return { kind: "not_found" as const };
        if (!project.rows[0].can_work) return { kind: "forbidden" as const };
        if (["completed", "archived"].includes(project.rows[0].status)) {
          return { kind: "project_closed" as const };
        }

        const lockScope = `${organizationId.toLowerCase()}:${projectId.toLowerCase()}:${principal.userId}:${operation}:${keyHash}`;
        await transaction.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [lockScope],
        );
        const existing = await transaction.query<{
          request_hash: string;
          response_status: number;
          response_body: { comment: TaskComment };
          expires_at: Date;
        }>(
          `SELECT request_hash, response_status, response_body, expires_at
           FROM nexora.project_mutation_idempotency
           WHERE organization_id = $1 AND project_id = $2 AND actor_user_id = $3
             AND operation = $4 AND key_hash = $5`,
          [organizationId, projectId, principal.userId, operation, keyHash],
        );
        const prior = existing.rows[0];
        if (prior && prior.expires_at > new Date()) {
          if (prior.request_hash !== requestHash) return { kind: "idempotency_conflict" as const };
          return { kind: "replayed" as const, comment: prior.response_body.comment, status: prior.response_status };
        }
        if (prior) {
          await transaction.query(
            `DELETE FROM nexora.project_mutation_idempotency
             WHERE organization_id = $1 AND project_id = $2 AND actor_user_id = $3
               AND operation = $4 AND key_hash = $5`,
            [organizationId, projectId, principal.userId, operation, keyHash],
          );
        }

        await lockProjectTaskGraph(transaction, organizationId, projectId);
        const task = await transaction.query<{ archived_at: Date | null; milestone_id: string | null; title: string }>(
          `SELECT archived_at, milestone_id, title
           FROM nexora.tasks
           WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
          [organizationId, projectId, taskId],
        );
        if (!task.rows[0]) return { kind: "task_not_found" as const };
        if (task.rows[0].archived_at) return { kind: "task_archived" as const };
        if (task.rows[0].milestone_id) {
          const milestone = await transaction.query<{ status: string }>(
            `SELECT status::text AS status
             FROM nexora.milestones
             WHERE organization_id = $1 AND project_id = $2 AND id = $3
             FOR SHARE`,
            [organizationId, projectId, task.rows[0].milestone_id],
          );
          if (milestone.rows[0]?.status === "completed") return { kind: "milestone_closed" as const };
        }

        const mentionIds = [...new Set(
          [...parsed.value.body.matchAll(MENTION_TOKEN_PATTERN)].map((match) => match[1]!.toLowerCase()),
        )];
        const mentionedMembers = mentionIds.length
          ? await transaction.query<{ user_id: string; display_name: string }>(
              `SELECT user_id, display_name
               FROM nexora.list_current_project_members($1, $2)
               WHERE status = 'active' AND user_id = ANY($3::uuid[])
               ORDER BY user_id`,
              [organizationId, projectId, mentionIds],
            )
          : { rows: [] as Array<{ user_id: string; display_name: string }> };
        if (mentionedMembers.rows.length !== mentionIds.length) return { kind: "mention_not_available" as const };

        const inserted = await transaction.query<TaskComment>(
          `INSERT INTO nexora.task_comments
           (id, organization_id, project_id, task_id, author_user_id, body)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, body, created_at`,
          [commentId, organizationId, projectId, taskId, principal.userId, parsed.value.body],
        );
        const commentRow = inserted.rows[0];
        if (!commentRow) throw new Error("Created comment could not be read");
        if (mentionIds.length) {
          await transaction.query(
            `INSERT INTO nexora.task_comment_mentions
               (organization_id, project_id, task_id, comment_id, mentioned_user_id)
             SELECT $1, $2, $3, $4, mentioned_user_id
             FROM pg_catalog.unnest($5::uuid[]) AS mentions(mentioned_user_id)`,
            [organizationId, projectId, taskId, commentId, mentionIds],
          );
        }
        const author = await transaction.query<{ display_name: string }>(
          `SELECT display_name FROM nexora.list_current_project_members($1, $2)
           WHERE user_id = $3 LIMIT 1`,
          [organizationId, projectId, principal.userId],
        );
        const comment = {
          ...commentRow,
          author_name: author.rows[0]?.display_name ?? null,
          mentions: mentionedMembers.rows,
        };

        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'task.comment_created', 'task', $4, $5::jsonb)`,
          [auditId, organizationId, principal.userId, taskId, JSON.stringify({ commentId, mentionCount: mentionIds.length })],
        );
        for (const mentionedMember of mentionedMembers.rows) {
          await notifyProjectMember(transaction, {
            organizationId,
            projectId,
            recipientUserId: mentionedMember.user_id,
            actorUserId: principal.userId,
            eventType: "mention",
            targetType: "task",
            targetId: taskId,
            dedupeKey: `mention:${commentId}:${mentionedMember.user_id}`,
            title: "You were mentioned",
            body: `${author.rows[0]?.display_name ?? "A project member"} mentioned you on "${task.rows[0].title}".`,
          });
        }
        await notifyProjectMembers(transaction, {
          organizationId,
          projectId,
          actorUserId: principal.userId,
          eventId: auditId,
          targetType: "task",
          targetId: taskId,
          title: "New project activity",
          body: `A comment was added to "${task.rows[0].title}".`,
          excludedUserIds: mentionIds,
        });
        const responseBody = { comment };
        await transaction.query(
          `INSERT INTO nexora.project_mutation_idempotency
             (organization_id, project_id, actor_user_id, operation, key_hash,
              request_hash, response_status, response_body)
           VALUES ($1, $2, $3, $4, $5, $6, 201, $7::jsonb)`,
          [organizationId, projectId, principal.userId, operation, keyHash, requestHash, JSON.stringify(responseBody)],
        );
        return { kind: "created" as const, comment };
      },
      "guest",
    );

    if (result.kind === "not_found") return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    if (result.kind === "forbidden") return jsonError(request, 403, "PROJECT_WORK_ACCESS_REQUIRED", "You do not have permission to comment in this project.");
    if (result.kind === "project_closed") return jsonError(request, 409, "PROJECT_CLOSED", "Comments cannot be added in a completed or archived project.");
    if (result.kind === "idempotency_conflict") return jsonError(request, 409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for different comment text.");
    if (result.kind === "task_not_found") return jsonError(request, 404, "TASK_NOT_FOUND", "Task not found.");
    if (result.kind === "task_archived") return jsonError(request, 409, "TASK_ARCHIVED", "Comments cannot be added to an archived task.");
    if (result.kind === "milestone_closed") return jsonError(request, 409, "MILESTONE_CLOSED", "Comments cannot be added to a task in a completed milestone.");
    if (result.kind === "mention_not_available") return jsonError(request, 409, "COMMENT_MENTION_NOT_AVAILABLE", "Mentions must refer to active members of this project.");
    return jsonOk(request, { comment: result.comment }, result.kind === "created" ? 201 : result.status);
  } catch (error) {
    return jsonServerFailure(request, "task-comments.create", error);
  }
}
