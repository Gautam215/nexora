import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  MAX_TASK_FILE_BYTES,
  MAX_TASK_FILE_COUNT,
  readBoundedFileBody,
  validatePrivateFile,
} from "../../../../../../../../../security/private-files.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
} from "../../../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../../../server/auth-rate-limit.ts";
import {
  TransactionCommitOutcomeUnknown,
  withOrganizationContext,
  type DatabaseTransaction,
} from "../../../../../../../../../server/db.ts";
import { notifyProjectMembers } from "../../../../../../../../../server/project-notifications.ts";
import { lockProjectForWork, lockProjectTaskGraph } from "../../../../../../../../../server/project-work.ts";
import { readTaskFileScope, taskFileWriteBlock } from "../../../../../../../../../server/task-file-access.ts";
import {
  publicTaskFile,
  privateFileSigningKey,
  requestedPrivateFilename,
  type PublicTaskFile,
  type TaskFileRecord,
} from "../../../../../../../../../server/task-files.ts";
import { writePrivateFile, removePrivateFile } from "../../../../../../../../../server/private-file-storage.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string; taskId: string }>;
}

interface FileResponseBody {
  file: PublicTaskFile;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

async function readFileRows(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
  taskId: string,
): Promise<TaskFileRecord[]> {
  const result = await transaction.query<TaskFileRecord>(
    `SELECT file.id, file.organization_id, file.project_id, file.task_id,
            file.original_filename, file.mime_type, file.byte_size::text AS byte_size,
            file.sha256, file.storage_key, file.uploaded_by_user_id, file.version,
            file.created_at, file.updated_at, file.deleted_at, file.deleted_by_user_id,
            uploader.display_name AS uploaded_by_name
     FROM nexora.task_files AS file
     LEFT JOIN LATERAL (
       SELECT member.display_name
       FROM nexora.list_current_project_members($1, $2) AS member
       WHERE member.user_id = file.uploaded_by_user_id
       LIMIT 1
     ) AS uploader ON true
     WHERE file.organization_id = $1 AND file.project_id = $2
       AND file.task_id = $3 AND file.deleted_at IS NULL
     ORDER BY file.created_at DESC, file.id DESC`,
    [organizationId, projectId, taskId],
  );
  return result.rows;
}

function taskFileScopeError(request: NextRequest, kind: string) {
  if (kind === "not_found") return jsonError(request, 404, "TASK_NOT_FOUND", "Task not found.");
  if (kind === "forbidden") return jsonError(request, 403, "PROJECT_WORK_ACCESS_REQUIRED", "You do not have permission to change files in this project.");
  if (kind === "project_closed") return jsonError(request, 409, "PROJECT_CLOSED", "Files cannot be changed in a completed or archived project.");
  if (kind === "task_archived") return jsonError(request, 409, "TASK_ARCHIVED", "Files cannot be changed on an archived task.");
  if (kind === "milestone_closed") return jsonError(request, 409, "MILESTONE_CLOSED", "Files cannot be changed on a task in a completed milestone.");
  return null;
}

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
        const scope = await readTaskFileScope(transaction, organizationId, projectId, taskId);
        if (scope.kind === "not_found") return null;
        return readFileRows(transaction, organizationId, projectId, taskId);
      },
      "guest",
    );
    if (!result) return jsonError(request, 404, "TASK_NOT_FOUND", "Task not found.");
    return jsonOk(request, { files: result.map(publicTaskFile) });
  } catch (error) {
    return jsonServerFailure(request, "task-files.list", error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId, taskId } = await params;
    if (![projectId, taskId].every((value) => UUID_PATTERN.test(value))) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project or task identifier is invalid.");
    }
    if (!privateFileSigningKey()) return jsonError(request, 503, "FILE_STORAGE_NOT_CONFIGURED", "Private file access is not configured yet.");
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return jsonError(request, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid idempotency key and retry.");
    }
    if (await isRateLimited(request, "task-file-upload", principal.userId, 20, 3600, 80)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many file changes. Wait before trying again.", { "retry-after": "3600" });
    }

    const preflight = await withOrganizationContext(
      principal.userId,
      organizationId,
      (transaction) => readTaskFileScope(transaction, organizationId, projectId, taskId),
      "guest",
    );
    if (preflight.kind === "not_found") return jsonError(request, 404, "TASK_NOT_FOUND", "Task not found.");
    const blocked = taskFileWriteBlock(preflight);
    if (blocked) return taskFileScopeError(request, blocked)!;

    const body = await readBoundedFileBody(request);
    if (!body.ok) return jsonError(request, body.status, body.code, body.message);
    const filename = requestedPrivateFilename(request);
    const mimeType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (!filename) return jsonError(request, 400, "INVALID_FILENAME", "Provide a valid file name.");
    const validation = validatePrivateFile(filename, mimeType, body.bytes);
    if (!validation.ok) return jsonError(request, 415, validation.code, validation.message);

    const fileId = randomUUID();
    const storageKey = randomUUID();
    const auditId = randomUUID();
    const digest = createHash("sha256").update(body.bytes).digest("hex");
    const operation = "file.upload";
    const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    const requestHash = createHash("sha256").update(JSON.stringify({
      taskId: taskId.toLowerCase(),
      filename: validation.filename,
      mimeType: validation.mimeType,
      byteSize: body.bytes.byteLength,
      sha256: digest,
    })).digest("hex");

    await writePrivateFile(storageKey, body.bytes);
    let stagedStorageKey: string | null = storageKey;
    try {
      const result = await withOrganizationContext(
        principal.userId,
        organizationId,
        async (transaction) => {
          await lockProjectForWork(transaction, organizationId, projectId);
          await lockProjectTaskGraph(transaction, organizationId, projectId);
          const scope = await readTaskFileScope(transaction, organizationId, projectId, taskId);
          if (scope.kind === "not_found") return { kind: "not_found" as const };
          const writeBlock = taskFileWriteBlock(scope);
          if (writeBlock) return { kind: writeBlock };

          const lockScope = `${organizationId.toLowerCase()}:${projectId.toLowerCase()}:${principal.userId}:${operation}:${keyHash}`;
          await transaction.query(
            "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
            [lockScope],
          );
          const existing = await transaction.query<{
            request_hash: string;
            response_status: number;
            response_body: FileResponseBody;
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
            return { kind: "replayed" as const, file: prior.response_body.file, status: prior.response_status };
          }
          if (prior) {
            await transaction.query(
              `DELETE FROM nexora.project_mutation_idempotency
               WHERE organization_id = $1 AND project_id = $2 AND actor_user_id = $3
                 AND operation = $4 AND key_hash = $5`,
              [organizationId, projectId, principal.userId, operation, keyHash],
            );
          }

          const usage = await transaction.query<{ file_count: number; byte_count: string }>(
            `SELECT count(*)::integer AS file_count,
                    COALESCE(sum(byte_size), 0)::text AS byte_count
             FROM nexora.task_files
             WHERE organization_id = $1 AND project_id = $2 AND task_id = $3
               AND deleted_at IS NULL`,
            [organizationId, projectId, taskId],
          );
          const currentCount = usage.rows[0]?.file_count ?? 0;
          const currentBytes = Number(usage.rows[0]?.byte_count ?? 0);
          if (currentCount >= MAX_TASK_FILE_COUNT) return { kind: "file_count_limit" as const };
          if (currentBytes + body.bytes.byteLength > MAX_TASK_FILE_BYTES) return { kind: "task_size_limit" as const };

          const inserted = await transaction.query<TaskFileRecord>(
            `INSERT INTO nexora.task_files
               (id, organization_id, project_id, task_id, original_filename,
                mime_type, byte_size, sha256, storage_key, uploaded_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, organization_id, project_id, task_id, original_filename,
                       mime_type, byte_size::text AS byte_size, sha256, storage_key,
                       uploaded_by_user_id, version, created_at, updated_at,
                       deleted_at, deleted_by_user_id`,
            [fileId, organizationId, projectId, taskId, validation.filename, validation.mimeType,
              body.bytes.byteLength, digest, storageKey, principal.userId],
          );
          const fileRecord = inserted.rows[0];
          if (!fileRecord) throw new Error("Uploaded file metadata could not be read");
          const file = publicTaskFile(fileRecord);
          await transaction.query(
            `INSERT INTO nexora.audit_events
               (id, organization_id, actor_user_id, action, target_type, target_id, details)
             VALUES ($1, $2, $3, 'task.file_uploaded', 'task', $4, $5::jsonb)`,
            [auditId, organizationId, principal.userId, taskId,
              JSON.stringify({ fileId, mimeType: validation.mimeType, byteSize: body.bytes.byteLength })],
          );
          await notifyProjectMembers(transaction, {
            organizationId,
            projectId,
            actorUserId: principal.userId,
            eventId: auditId,
            targetType: "task",
            targetId: taskId,
            title: "Task file added",
            body: `A file was attached to a project task.`,
          });
          const responseBody = { file };
          await transaction.query(
            `INSERT INTO nexora.project_mutation_idempotency
               (organization_id, project_id, actor_user_id, operation, key_hash,
                request_hash, response_status, response_body)
             VALUES ($1, $2, $3, $4, $5, $6, 201, $7::jsonb)`,
            [organizationId, projectId, principal.userId, operation, keyHash, requestHash, JSON.stringify(responseBody)],
          );
          return { kind: "created" as const, file };
        },
        "guest",
      );

      if (result.kind !== "created") {
        await removePrivateFile(storageKey);
        stagedStorageKey = null;
      }
      if (result.kind === "not_found") return jsonError(request, 404, "TASK_NOT_FOUND", "Task not found.");
      if (result.kind === "forbidden") return taskFileScopeError(request, result.kind)!;
      if (result.kind === "project_closed" || result.kind === "task_archived" || result.kind === "milestone_closed") {
        return taskFileScopeError(request, result.kind)!;
      }
      if (result.kind === "idempotency_conflict") return jsonError(request, 409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for different file contents.");
      if (result.kind === "file_count_limit") return jsonError(request, 409, "TASK_FILE_COUNT_LIMIT", "A task can have at most 20 active files.");
      if (result.kind === "task_size_limit") return jsonError(request, 409, "TASK_FILE_STORAGE_LIMIT", "A task can use at most 100 MB of active files.");
      if (result.kind === "replayed") return jsonOk(request, { file: result.file }, result.status);
      stagedStorageKey = null;
      return jsonOk(request, { file: result.file }, 201);
    } catch (error) {
      if (stagedStorageKey && !(error instanceof TransactionCommitOutcomeUnknown)) {
        await removePrivateFile(stagedStorageKey).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    return jsonServerFailure(request, "task-files.upload", error);
  }
}
