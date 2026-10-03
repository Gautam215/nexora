import ProjectMilestonesPage from "../../../../../components/project-milestones-page";

export default async function MilestonesRoute({
  params,
}: {
  params: Promise<{ organizationId: string; projectId: string }>;
}) {
  const { organizationId, projectId } = await params;
  return <ProjectMilestonesPage organizationId={organizationId} projectId={projectId} />;
}
