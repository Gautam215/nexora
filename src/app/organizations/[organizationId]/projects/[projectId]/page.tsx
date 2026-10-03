import ProjectPage from "../../../../components/project-page";

export default async function ProjectRoute({
  params,
}: {
  params: Promise<{ organizationId: string; projectId: string }>;
}) {
  const { organizationId, projectId } = await params;
  return <ProjectPage organizationId={organizationId} projectId={projectId} />;
}
