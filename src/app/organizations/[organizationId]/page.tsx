import OrganizationPage from "../../components/organization-page";

export default async function OrganizationRoute({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <OrganizationPage organizationId={organizationId} />;
}
