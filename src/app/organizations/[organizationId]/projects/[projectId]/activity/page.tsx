import ProjectActivityPage from "../../../../../components/project-activity-page";

export default async function ActivityRoute({
  params,
}: {
  params: Promise<{ organizationId: string; projectId: string }>;
}) {
  const { organizationId, projectId } = await params;
  return <ProjectActivityPage organizationId={organizationId} projectId={projectId} />;
}
