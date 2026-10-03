import type { NextRequest } from "next/server";
import type { SearchEntityType, SearchRequest } from "../../../../../security/search-schemas.ts";
import { hasMoreSearchResults, parseSearchRequest } from "../../../../../security/search-schemas.ts";
import { jsonError, jsonOk, jsonServerFailure } from "../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../server/db.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

interface SearchResult {
  entity_type: SearchEntityType;
  id: string;
  title: string;
  context: string;
  preview: string;
  created_at: string;
  href: string;
  related_project_id: string | null;
  related_task_title: string | null;
}

const SEARCH_SOURCES: Record<SearchEntityType, string> = {
  project: `
    SELECT 'project'::text AS entity_type,
           project.id::text AS id,
           project.name::text AS title,
           project.status::text AS context,
           pg_catalog.left(COALESCE(project.description, ''), 240)::text AS preview,
           project.created_at,
           ('/organizations/' || $1::text || '/projects/' || project.id::text)::text AS href,
           NULL::text AS related_project_id,
           NULL::text AS related_task_title
    FROM nexora.projects AS project
    WHERE project.organization_id = $1::uuid
      AND ($3::uuid IS NULL OR project.id = $3)
      AND pg_catalog.to_tsvector(
        'simple'::pg_catalog.regconfig,
        project.name || ' ' || COALESCE(project.description, '')
      ) @@ pg_catalog.plainto_tsquery('simple'::pg_catalog.regconfig, $2)
  `,
  task: `
    SELECT 'task'::text AS entity_type,
           task.id::text AS id,
           task.title::text AS title,
           (project.name || ' - ' || workflow.name)::text AS context,
           pg_catalog.left(COALESCE(task.description, ''), 240)::text AS preview,
           task.created_at,
           ('/organizations/' || $1::text || '/projects/' || project.id::text || '/tasks?view=list')::text AS href,
           project.id::text AS related_project_id,
           task.title::text AS related_task_title
    FROM nexora.tasks AS task
    JOIN nexora.projects AS project
      ON project.organization_id = task.organization_id
     AND project.id = task.project_id
    JOIN nexora.project_task_statuses AS workflow
      ON workflow.organization_id = task.organization_id
     AND workflow.project_id = task.project_id
     AND workflow.id = task.workflow_status_id
    WHERE task.organization_id = $1::uuid
      AND task.archived_at IS NULL
      AND ($3::uuid IS NULL OR task.project_id = $3)
      AND pg_catalog.to_tsvector(
        'simple'::pg_catalog.regconfig,
         task.title || ' ' || COALESCE(task.description, '') || ' ' || nexora.searchable_task_labels(task.labels)
      ) @@ pg_catalog.plainto_tsquery('simple'::pg_catalog.regconfig, $2)
  `,
  comment: `
    SELECT 'comment'::text AS entity_type,
           comment.id::text AS id,
           task.title::text AS title,
           (project.name || ' - task comment')::text AS context,
           pg_catalog.left(comment.body, 240)::text AS preview,
           comment.created_at,
           ('/organizations/' || $1::text || '/projects/' || project.id::text || '/tasks?view=list')::text AS href,
           project.id::text AS related_project_id,
           task.title::text AS related_task_title
    FROM nexora.task_comments AS comment
    JOIN nexora.tasks AS task
      ON task.organization_id = comment.organization_id
     AND task.project_id = comment.project_id
     AND task.id = comment.task_id
    JOIN nexora.projects AS project
      ON project.organization_id = task.organization_id
     AND project.id = task.project_id
    WHERE comment.organization_id = $1::uuid
      AND task.archived_at IS NULL
      AND ($3::uuid IS NULL OR comment.project_id = $3)
      AND pg_catalog.to_tsvector(
        'simple'::pg_catalog.regconfig,
        comment.body
      ) @@ pg_catalog.plainto_tsquery('simple'::pg_catalog.regconfig, $2)
  `,
  member: `
    SELECT 'member'::text AS entity_type,
           member.user_id::text AS id,
           member.display_name::text AS title,
           member.role::text AS context,
           ''::text AS preview,
           COALESCE(member.joined_at, '1970-01-01'::timestamptz) AS created_at,
           ('/organizations/' || $1::text || '/members')::text AS href,
           NULL::text AS related_project_id,
           NULL::text AS related_task_title
    FROM nexora.list_current_organization_members($1::uuid) AS member
    WHERE member.status = 'active'
      AND ($3::uuid IS NULL OR EXISTS (
        SELECT 1
        FROM nexora.project_memberships AS project_member
         WHERE project_member.organization_id = $1::uuid
           AND project_member.project_id = $3
          AND project_member.user_id = member.user_id
          AND project_member.status = 'active'
      ))
      AND pg_catalog.to_tsvector(
        'simple'::pg_catalog.regconfig,
        member.display_name
      ) @@ pg_catalog.plainto_tsquery('simple'::pg_catalog.regconfig, $2)
  `,
  file: `
    SELECT 'file'::text AS entity_type,
           file.id::text AS id,
           file.original_filename::text AS title,
           (project.name || ' - ' || task.title)::text AS context,
           (file.mime_type || ' - ' || file.byte_size::text || ' bytes')::text AS preview,
           file.created_at,
           ('/organizations/' || $1::text || '/projects/' || project.id::text || '/tasks?view=list')::text AS href,
           project.id::text AS related_project_id,
           task.title::text AS related_task_title
    FROM nexora.task_files AS file
    JOIN nexora.tasks AS task
      ON task.organization_id = file.organization_id
     AND task.project_id = file.project_id
     AND task.id = file.task_id
    JOIN nexora.projects AS project
      ON project.organization_id = task.organization_id
     AND project.id = task.project_id
    WHERE file.organization_id = $1::uuid
      AND file.deleted_at IS NULL
      AND task.archived_at IS NULL
      AND ($3::uuid IS NULL OR file.project_id = $3)
      AND pg_catalog.to_tsvector(
        'simple'::pg_catalog.regconfig,
        file.original_filename
      ) @@ pg_catalog.plainto_tsquery('simple'::pg_catalog.regconfig, $2)
  `,
};

function selectedSources(type: SearchRequest["type"]): string[] {
  return type === "all" ? Object.values(SEARCH_SOURCES) : [SEARCH_SOURCES[type]];
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const parsed = parseSearchRequest(request.nextUrl.searchParams);
  if (!parsed.success) {
    return jsonError(
      request,
      400,
      "INVALID_SEARCH",
      "Enter 2-120 characters and use a supported filter and page range.",
    );
  }

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    if (await isRateLimited(request, "workspace-search", principal.userId, 60, 3600, 120)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Search is temporarily rate limited. Try again later.",
        { "retry-after": "3600" },
      );
    }

    const { organizationId } = await params;
    const { q, type, projectId, limit, offset } = parsed.data;
    const sources = selectedSources(type);
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => transaction.query<{
        total: number;
        results: SearchResult[];
      }>(
        `WITH matches AS (
           ${sources.join("\nUNION ALL\n")}
         )
         SELECT (
                  SELECT pg_catalog.count(*)::integer
                  FROM matches
                ) AS total,
                COALESCE(
                  (
                    SELECT pg_catalog.jsonb_agg(
                      pg_catalog.to_jsonb(page)
                      ORDER BY page.created_at DESC, page.entity_type, page.id
                    )
                    FROM (
                      SELECT *
                      FROM matches
                      ORDER BY created_at DESC, entity_type, id
                      LIMIT $4 OFFSET $5
                    ) AS page
                  ),
                  '[]'::jsonb
                ) AS results`,
        [organizationId, q, projectId ?? null, limit, offset],
      ),
      "guest",
    );
    const page = result.rows[0] ?? { total: 0, results: [] };
    return jsonOk(request, {
      results: page.results.map(({ related_project_id, related_task_title, ...entry }) => ({
        ...entry,
        ...(related_project_id && related_task_title
          ? {
              href: `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(related_project_id)}/tasks?view=list&q=${encodeURIComponent(related_task_title.slice(0, 120))}`,
            }
          : {}),
      })),
      pagination: {
        total: page.total,
        limit,
        offset,
        hasMore: hasMoreSearchResults(offset, page.results.length, page.total),
      },
    });
  } catch (error) {
    return jsonServerFailure(request, "workspace-search.list", error);
  }
}
