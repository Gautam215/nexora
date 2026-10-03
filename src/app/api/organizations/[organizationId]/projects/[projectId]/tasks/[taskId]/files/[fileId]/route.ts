import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  MAX_TASK_FILE_BYTES,
  MAX_TASK_FILE_COUNT,
  PRIVATE_FILE_LINK_TTL_SECONDS,
  createPrivateFileToken,
  readBoundedFileBody,
  validatePrivateFile,
  verifyPrivateFileToken,
} from "../../../../../../../../../../security/private-files.ts";
import { hasSameOrigin, jsonError, jsonOk, jsonServerFailure } from "../../../../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../../../../server/auth.ts";
import { isRateLimited, isTokenRateLimited } from "../../../../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext, type DatabaseTransaction } from "../../../../../../../../../../server/db.ts";
import { notifyProjectMembers } from "../../../../../../../../../../server/project-notifications.ts";
import { lockProjectForWork, lockProjectTaskGraph } from "../../../../../../../../../../server/project-work.ts";
import { readTaskFileScope, taskFileWriteBlock } from "../../../../../../../../../../server/task-file-access.ts";
import {
  privateFileContentDisposition,
  privateFileSigningKey,
  publicTaskFile,
  requestedPrivateFilename,
  type PublicTaskFile,
  type TaskFileRecord,
} from "../../../../../../../../../../server/task-files.ts";
import { readPrivateFile, removePrivateFile, writePrivateFile } from "../../../../../../../../../../server/private-file-storage.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string; taskId: string; fileId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function responseRequestId(request: NextRequest): string {
  const candidate = request.headers.get("x-request-id");
  return candidate && /^[A-Za-z0-9._:-]{1,80}$/.test(candidate) ? candidate : randomUUID();
}

async function readActiveFile(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
  taskId: string,
  fileId: string,
  lock = false,
): Promise<TaskFileRecord | null> {
  const result = await transaction.query<TaskFileRecord>(
    `SELECT id, organization_id, project_id, task_id, original_filename,
            mime_type, byte_size::text AS byte_size, sha256, storage_key,
            uploaded_by_user_id, version, created_at, updated_at,
            deleted_at, deleted_by_user_id
     FROM nexora.task_files
     WHERE organization_id = $1 AND project_id = $2 AND task_id = $3
       AND id = $4 AND deleted_at IS NULL
     ${lock ? "FOR UPDATE" : ""}`,
    [organizationId, projectId, taskId, fileId],
  );
  return result.rows[0] ?? null;
}

function invalidIdentifier(request: NextRequest) {
  return jsonError(request, 400, "INVALID_IDENTIFIER", "Project, task, or file identifier is invalid.");
}

function writeBlockResponse(request: NextRequest, kind: string) {
  if (kind === "forbidden") return jsonError(request, 403, "PROJECT_WORK_ACCESS_REQUIRED", "You do not have permission to change files in this project.");
  if (kind === "project_closed") return jsonError(request, 409, "PROJECT_CLOSED", "Files cannot be changed in a completed or archived project.");
  if (kind === "task_archived") return jsonError(request, 409, "TASK_ARCHIVED", "Files cannot be changed on an archived task.");
  if (kind === "milestone_closed") return jsonError(request, 409, "MILESTONE_CLOSED", "Files cannot be changed on a task in a completed milestone.");
  return null;
}

function sameDigest(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const { organizationId, projectId, taskId, fileId } = await params;
    if (![organizationId, projectId, taskId, fileId].every((value) => UUID_PATTERN.test(value))) {
      return invalidIdentifier(request);
    }
    const token = request.nextUrl.searchParams.get("token");
    const signingKey = privateFileSigningKey();
    if (!signingKey) return jsonError(request, 503, "FILE_STORAGE_NOT_CONFIGURED", "Private file access is not configured yet.");

    if (token !== null) {
      const claims = verifyPrivateFileToken(token, signingKey);
      if (!claims ||
          claims.organizationId.toLowerCase() !== organizationId.toLowerCase() ||
          claims.projectId.toLowerCase() !== projectId.toLowerCase() ||
          claims.taskId.toLowerCase() !== taskId.toLowerCase() ||
          claims.fileId.toLowerCase() !== fileId.toLowerCase()) {
        return jsonError(request, 403, "SIGNED_FILE_URL_INVALID", "This private file link is invalid or has expired.");
      }
      if (await isTokenRateLimited(request, "project-management-user", token, 60, 60, 60)) {
        return jsonError(request, 429, "RATE_LIMITED", "Too many file downloads. Wait before trying again.", { "retry-after": "60" });
      }
      const authorized = await withOrganizationContext(
        claims.userId,
        organizationId,
        async (transaction) => {
          const scope = await readTaskFileScope(transaction, organizationId, projectId, taskId);
          if (scope.kind === "not_found") return null;
          const file = await readActiveFile(transaction, organizationId, projectId, taskId, fileId);
          return file?.version === claims.version ? file : null;
        },
        "guest",
      );
      if (!authorized) return jsonError(request, 404, "FILE_NOT_FOUND", "This private file is no longer available.");

      const bytes = await readPrivateFile(authorized.storage_key, Number(authorized.byte_size));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (!sameDigest(digest, authorized.sha256)) throw new Error("Private file integrity check failed");
      return new Response(bytes, {
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": privateFileContentDisposition(authorized.original_filename),
          "content-length": String(bytes.byteLength),
          "content-security-policy": "sandbox; default-src 'none'; script-src 'none'; style-src 'none'",
          "content-type": authorized.mime_type,
          "referrer-policy": "no-referrer",
          "x-request-id": responseRequestId(request),
          "x-content-type-options": "nosniff",
        },
      });
    }

    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    if (await isRateLimited(request, "project-management-user", principal.userId, 40, 3600, 80)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many file requests. Wait before trying again.", { "retry-after": "3600" });
    }
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const scope = await readTaskFileScope(transaction, organizationId, projectId, taskId);
        if (scope.kind === "not_found") return null;
        const file = await readActiveFile(transaction, organizationId, projectId, taskId, fileId);
        return file ? publicTaskFile(file) : null;
      },
      "guest",
    );
    if (!result) return jsonError(request, 404, "FILE_NOT_FOUND", "File not found.");

    const expiresAt = Math.floor(Date.now() / 1000) + PRIVATE_FILE_LINK_TTL_SECONDS;
    const signedToken = createPrivateFileToken({
      organizationId,
      projectId,
      taskId,
      fileId,
      userId: principal.userId,
      version: result.version,
      expiresAt,
    }, signingKey);
    const url = `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}` +
      `/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}?token=${encodeURIComponent(signedToken)}`;
    return jsonOk(request, { url, expiresAt: new Date(expiresAt * 1000).toISOString() });
  } catch (error) {
    return jsonServerFailure(request, "task-files.download", error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId, taskId, fileId } = await params;
    if (![organizationId, projectId, taskId, fileId].every((value) => UUID_PATTERN.test(value))) return invalidIdentifier(request);
    const versionValue = request.headers.get("if-match")?.replace(/^"|"$/g, "") ?? "";
    if (!/^[1-9]\d{0,8}$/.test(versionValue)) {
      return jsonError(request, 428, "FILE_VERSION_REQUIRED", "Reload the file list before replacing a file.");
    }
    const expectedVersion = Number(versionValue);
    if (await isRateLimited(request, "task-file-upload", principal.userId, 20, 3600, 80)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many file changes. Wait before trying again.", { "retry-after": "3600" });
    }
    if (!privateFileSigningKey()) return jsonError(request, 503, "FILE_STORAGE_NOT_CONFIGURED", "Private file access is not configured yet.");

    const preflight = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const scope = await readTaskFileScope(transaction, organizationId, projectId, taskId);
        if (scope.kind === "not_found") return { kind: "not_found" as const };
        const block = taskFileWriteBlock(scope);
        if (block) return { kind: block };
        const file = await readActiveFile(transaction, organizationId, projectId, taskId, fileId);
        return file ? { kind: "ok" as const, file } : { kind: "file_not_found" as const };
      },
      "guest",
    );
    if (preflight.kind === "not_found" || preflight.kind === "file_not_found") {
      return jsonError(request, 404, "FILE_NOT_FOUND", "File not found.");
    }
    if (preflight.kind !== "ok") return writeBlockResponse(request, preflight.kind)!;
    if (preflight.file.version !== expectedVersion) return jsonError(request, 409, "FILE_VERSION_CONFLICT", "This file changed elsewhere. Reload before replacing it.");

    const body = await readBoundedFileBody(request);
    if (!body.ok) return jsonError(request, body.status, body.code, body.message);
    const filename = requestedPrivateFilename(request);
    const mimeType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (!filename) return jsonError(request, 400, "INVALID_FILENAME", "Provide a valid file name.");
    const validation = validatePrivateFile(filename, mimeType, body.bytes);
    if (!validation.ok) return jsonError(request, 415, validation.code, validation.message);

    const storageKey = randomUUID();
    const digest = createHash("sha256").update(body.bytes).digest("hex");
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
          const block = taskFileWriteBlock(scope);
          if (block) return { kind: block };
          const current = await readActiveFile(transaction, organizationId, projectId, taskId, fileId, true);
          if (!current) return { kind: "file_not_found" as const };
          if (current.version !== expectedVersion) return { kind: "version_conflict" as const };

          const usage = await transaction.query<{ byte_count: string }>(
            `SELECT COALESCE(sum(byte_size), 0)::text AS byte_count
             FROM nexora.task_files
             WHERE organization_id = $1 AND project_id = $2 AND task_id = $3
               AND id <> $4 AND deleted_at IS NULL`,
            [organizationId, projectId, taskId, fileId],
          );
          if (Number(usage.rows[0]?.byte_count ?? 0) + body.bytes.byteLength > MAX_TASK_FILE_BYTES) {
            return { kind: "task_size_limit" as const };
          }
          const updated = await transaction.query<TaskFileRecord>(
            `UPDATE nexora.task_files
             SET original_filename = $1, mime_type = $2, byte_size = $3,
                 sha256 = $4, storage_key = $5, version = version + 1,
                 updated_at = pg_catalog.now()
             WHERE organization_id = $6 AND project_id = $7 AND task_id = $8
               AND id = $9 AND deleted_at IS NULL AND version = $10
             RETURNING id, organization_id, project_id, task_id, original_filename,
                       mime_type, byte_size::text AS byte_size, sha256, storage_key,
                       uploaded_by_user_id, version, created_at, updated_at,
                       deleted_at, deleted_by_user_id`,
            [validation.filename, validation.mimeType, body.bytes.byteLength, digest, storageKey,
              organizationId, projectId, taskId, fileId, expectedVersion],
          );
          const file = updated.rows[0];
          if (!file) return { kind: "version_conflict" as const };
          const auditId = randomUUID();
          await transaction.query(
            `INSERT INTO nexora.audit_events
               (id, organization_id, actor_user_id, action, target_type, target_id, details)
             VALUES ($1, $2, $3, 'task.file_replaced', 'task', $4, $5::jsonb)`,
            [auditId, organizationId, principal.userId, taskId,
              JSON.stringify({ fileId, version: file.version, mimeType: validation.mimeType, byteSize: body.bytes.byteLength })],
          );
          await notifyProjectMembers(transaction, {
            organizationId,
            projectId,
            actorUserId: principal.userId,
            eventId: auditId,
            targetType: "task",
            targetId: taskId,
            title: "Task file replaced",
            body: "A task attachment was replaced.",
          });
          return { kind: "replaced" as const, file: publicTaskFile(file), oldStorageKey: current.storage_key };
        },
        "guest",
      );

      if (result.kind !== "replaced") {
        await removePrivateFile(storageKey);
        stagedStorageKey = null;
      }
      if (result.kind === "not_found" || result.kind === "file_not_found") return jsonError(request, 404, "FILE_NOT_FOUND", "File not found.");
      if (result.kind === "forbidden" || result.kind === "project_closed" || result.kind === "task_archived" || result.kind === "milestone_closed") {
        return writeBlockResponse(request, result.kind)!;
      }
      if (result.kind === "version_conflict") return jsonError(request, 409, "FILE_VERSION_CONFLICT", "This file changed elsewhere. Reload before replacing it.");
      if (result.kind === "task_size_limit") return jsonError(request, 409, "TASK_FILE_STORAGE_LIMIT", "A task can use at most 100 MB of active files.");
      if (result.kind !== "replaced") return jsonError(request, 500, "INTERNAL_ERROR", "Unable to complete that request right now.");
      await removePrivateFile(result.oldStorageKey).catch(() => undefined);
      stagedStorageKey = null;
      return jsonOk(request, { file: result.file });
    } catch (error) {
      if (stagedStorageKey) await removePrivateFile(stagedStorageKey).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return jsonServerFailure(request, "task-files.replace", error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId, taskId, fileId } = await params;
    if (![organizationId, projectId, taskId, fileId].every((value) => UUID_PATTERN.test(value))) return invalidIdentifier(request);
    if (await isRateLimited(request, "task-file-upload", principal.userId, 20, 3600, 80)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many file changes. Wait before trying again.", { "retry-after": "3600" });
    }
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        await lockProjectForWork(transaction, organizationId, projectId);
        await lockProjectTaskGraph(transaction, organizationId, projectId);
        const scope = await readTaskFileScope(transaction, organizationId, projectId, taskId);
        if (scope.kind === "not_found") return { kind: "not_found" as const };
        const block = taskFileWriteBlock(scope);
        if (block) return { kind: block };
        const current = await readActiveFile(transaction, organizationId, projectId, taskId, fileId, true);
        if (!current) return { kind: "file_not_found" as const };
        await transaction.query(
          `UPDATE nexora.task_files
           SET deleted_at = pg_catalog.now(), deleted_by_user_id = $1,
               version = version + 1, updated_at = pg_catalog.now()
           WHERE organization_id = $2 AND project_id = $3 AND task_id = $4
             AND id = $5 AND deleted_at IS NULL`,
          [principal.userId, organizationId, projectId, taskId, fileId],
        );
        const auditId = randomUUID();
        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'task.file_deleted', 'task', $4, $5::jsonb)`,
          [auditId, organizationId, principal.userId, taskId, JSON.stringify({ fileId })],
        );
        await notifyProjectMembers(transaction, {
          organizationId,
          projectId,
          actorUserId: principal.userId,
          eventId: auditId,
          targetType: "task",
          targetId: taskId,
          title: "Task file removed",
          body: "A task attachment was removed.",
        });
        return { kind: "deleted" as const };
      },
      "guest",
    );
    if (result.kind === "not_found" || result.kind === "file_not_found") return jsonError(request, 404, "FILE_NOT_FOUND", "File not found.");
    if (result.kind === "forbidden" || result.kind === "project_closed" || result.kind === "task_archived" || result.kind === "milestone_closed") {
      return writeBlockResponse(request, result.kind)!;
    }
    return jsonOk(request, { deleted: true, retentionDays: 30 });
  } catch (error) {
    return jsonServerFailure(request, "task-files.delete", error);
  }
}
