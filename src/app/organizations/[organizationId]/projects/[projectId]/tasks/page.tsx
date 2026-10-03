import ProjectTasksPage from "../../../../../components/project-tasks-page";

export default async function TasksRoute({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; projectId: string }>;
  searchParams: Promise<{ view?: string; q?: string }>;
}) {
  const [{ organizationId, projectId }, query] = await Promise.all([params, searchParams]);
  const initialView = query.view === "list" ? "list" : "board";
  return <ProjectTasksPage
    organizationId={organizationId}
    projectId={projectId}
    initialView={initialView}
    initialQuery={query.q?.slice(0, 120) ?? ""}
  />;
}
