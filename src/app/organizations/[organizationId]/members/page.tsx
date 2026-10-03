import OrganizationMembersPage from "../../../components/organization-members-page";

export default async function OrganizationMembersRoute({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <OrganizationMembersPage organizationId={organizationId} />;
}
