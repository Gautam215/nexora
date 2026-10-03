import OrganizationSearchPage from "../../../components/organization-search-page";

export default async function OrganizationSearchRoute({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <OrganizationSearchPage organizationId={organizationId} />;
}
